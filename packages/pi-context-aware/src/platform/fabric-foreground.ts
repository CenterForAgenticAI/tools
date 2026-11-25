/**
 * Fabric foreground check. Identical copies live in pi-question
 * (src/adapters/fabric-foreground.ts) and pi-context-aware
 * (src/platform/fabric-foreground.ts); change both together.
 *
 * In pi-fabric's full code mode the model sees only fabric_exec plus the tools
 * named in fabric.json foreground.tools. Any other tool is reachable only as
 * extensions.<name> inside a program, which breaks tools that only work as a
 * direct model call: a question to the user, a compaction handoff, a skill
 * loader. This module asks Fabric where each wanted tool is reachable
 * (pi-fabric:tool-placement:v1) and, when one is program-only, offers once per
 * session to add it to fabric.json. It imports only node builtins, so both
 * packages can carry it without a shared dependency.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const FABRIC_TOOL_PLACEMENT_EVENT = "pi-fabric:tool-placement:v1";
/** Shared by every copy in one process, so the user sees one offer, not one per extension. */
const REGISTRY_KEY = Symbol.for("pi-fabric-foreground-check.v1");
/** pi-fabric src/core/foreground-tools.ts: MAX_FOREGROUND_TOOLS, MAX_FOREGROUND_ENTRIES, the default maxTools. */
const FABRIC_MAX_TOOLS = 8;
const FABRIC_MAX_ENTRIES = 64;
const FABRIC_DEFAULT_MAX_TOOLS = 4;
const DECLINED_FILE = "fabric-foreground-declined.json";

export type ForegroundReason = "turn-steering" | "human-input" | "context-control" | "skill-loading";
export interface ForegroundWant {
	readonly name: string;
	/** The extension that registers the tool; Fabric shows it in /fabric status. */
	readonly owner: string;
	readonly reason: ForegroundReason;
}

type Placement = "model" | "program" | "unavailable";
export interface PlacementReply {
	mode: "full-code" | "enforce" | "orchestration";
	tools: Record<string, Placement>;
}

export interface EventBus {
	emit(channel: string, data: unknown): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const readReply = (value: unknown): PlacementReply | undefined => {
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.tools)) return undefined;
	const mode = value.mode;
	if (mode !== "full-code" && mode !== "enforce" && mode !== "orchestration") return undefined;
	const tools: Record<string, Placement> = {};
	for (const [name, placement] of Object.entries(value.tools)) {
		if (placement === "model" || placement === "program" || placement === "unavailable") tools[name] = placement;
	}
	return { mode, tools };
};

/** Fabric answers synchronously; undefined means no compatible Fabric is loaded. */
export function queryPlacement(events: EventBus, names: readonly string[]): PlacementReply | undefined {
	let reply: PlacementReply | undefined;
	try {
		events.emit(FABRIC_TOOL_PLACEMENT_EVENT, { tools: [...names], reply: (result: unknown) => { reply = readReply(result); } });
	} catch {
		return undefined;
	}
	return reply;
}

/** Wanted tools Fabric hides from the model that a foreground entry would expose. */
export function programOnly(reply: PlacementReply | undefined, wants: readonly ForegroundWant[]): ForegroundWant[] {
	// Orchestration already declares every active tool; Schema enforce refuses every foreground entry.
	if (reply?.mode !== "full-code") return [];
	return wants.filter((want) => reply.tools[want.name] === "program");
}

// ---------------------------------------------------------------------------
// fabric.json edit
// ---------------------------------------------------------------------------

export interface ConfigFile {
	path: string;
	/** Raw file text, or null when the file does not exist. */
	source: string | null;
}

export type ForegroundPlan =
	| { kind: "write"; path: string; source: string | null; text: string; added: string[]; maxTools?: number }
	| { kind: "listed"; names: string[] }
	| { kind: "blocked"; reason: string };

const parseDocument = (file: ConfigFile): Record<string, unknown> | string => {
	if (file.source === null) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(file.source);
	} catch {
		return file.path + " is not valid JSON; fix it by hand first";
	}
	return isRecord(parsed) ? parsed : file.path + " is not a JSON object; fix it by hand first";
};

/**
 * Plan the smallest fabric.json change that lists every wanted tool.
 *
 * Fabric merges the global file, then a trusted project's .pi/fabric.json; objects
 * merge key by key and arrays replace. So the file to edit is the project file when
 * it sets foreground.tools or foreground.maxTools, otherwise the global file.
 */
export function planForegroundEdit(
	files: { global: ConfigFile; project?: ConfigFile | undefined },
	wants: readonly ForegroundWant[],
): ForegroundPlan {
	const globalDoc = parseDocument(files.global);
	if (typeof globalDoc === "string") return { kind: "blocked", reason: globalDoc };
	const projectDoc = files.project ? parseDocument(files.project) : undefined;
	if (typeof projectDoc === "string") return { kind: "blocked", reason: projectDoc };
	const foregroundOf = (doc: Record<string, unknown> | undefined, path: string): Record<string, unknown> | string => {
		const value = doc?.foreground;
		if (value === undefined) return {};
		return isRecord(value) ? value : path + ": foreground is not an object; fix it by hand first";
	};
	const globalFg = foregroundOf(globalDoc, files.global.path);
	if (typeof globalFg === "string") return { kind: "blocked", reason: globalFg };
	const projectFg = files.project ? foregroundOf(projectDoc, files.project.path) : {};
	if (typeof projectFg === "string") return { kind: "blocked", reason: projectFg };

	const projectWins = files.project !== undefined && (projectFg.tools !== undefined || projectFg.maxTools !== undefined);
	const target = projectWins && files.project ? files.project : files.global;
	const targetDoc = projectWins && projectDoc ? projectDoc : globalDoc;
	const targetFg = projectWins ? projectFg : globalFg;

	const tools = projectFg.tools ?? globalFg.tools ?? [];
	if (!Array.isArray(tools)) return { kind: "blocked", reason: "foreground.tools is not an array; fix it by hand first" };
	const maxTools = projectFg.maxTools ?? globalFg.maxTools ?? FABRIC_DEFAULT_MAX_TOOLS;
	if (!Number.isInteger(maxTools)) return { kind: "blocked", reason: "foreground.maxTools is not an integer; fix it by hand first" };

	const listed = new Set(tools.map((entry: unknown) => (isRecord(entry) ? entry.name : undefined)));
	const toAdd = wants.filter((want) => !listed.has(want.name));
	if (toAdd.length === 0) return { kind: "listed", names: wants.map((want) => want.name) };
	const nextTools = [...tools, ...toAdd.map(({ name, owner, reason }) => ({ name, owner, reason }))];
	if (nextTools.length > FABRIC_MAX_ENTRIES) {
		return { kind: "blocked", reason: "foreground.tools would exceed Fabric's " + FABRIC_MAX_ENTRIES + " entries" };
	}
	// Refused entries (unregistered, inactive) take no slot, so this can overshoot; it never undershoots.
	const nextMax = Math.min(FABRIC_MAX_TOOLS, Math.max(maxTools as number, nextTools.length));
	const raised = nextMax !== maxTools;
	const document = {
		...targetDoc,
		foreground: { ...targetFg, tools: nextTools, ...(raised ? { maxTools: nextMax } : {}) },
	};
	return {
		kind: "write",
		path: target.path,
		source: target.source,
		text: JSON.stringify(document, null, 2) + "\n",
		added: toAdd.map((want) => want.name),
		...(raised ? { maxTools: nextMax } : {}),
	};
}

const readSource = (path: string): string | null => {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
};

/**
 * Replace the file with text, through a same-directory rename. Refuses when the file
 * no longer holds expectedSource, so a concurrent edit is never silently lost.
 */
export function writeConfigAtomic(path: string, text: string, expectedSource: string | null): void {
	const target = existsSync(path) ? realpathSync(path) : path;
	if (readSource(target) !== expectedSource) throw new Error(path + " changed while it was being edited; try again");
	const directory = dirname(target);
	mkdirSync(directory, { recursive: true });
	const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
	const temporary = join(directory, "." + basename(target) + "." + process.pid + "." + Date.now() + ".tmp");
	try {
		writeFileSync(temporary, text, { encoding: "utf8", mode });
		renameSync(temporary, target);
	} catch (error) {
		try { unlinkSync(temporary); } catch { /* already renamed or never written */ }
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Paths and declines
// ---------------------------------------------------------------------------

export interface PathOptions {
	env?: Record<string, string | undefined>;
	home?: string;
}

/** The agent directory Fabric reads fabric.json from: $PI_CODING_AGENT_DIR, else ~/.pi/agent. */
export function agentDir({ env = process.env, home = homedir() }: PathOptions = {}): string {
	const configured = env.PI_CODING_AGENT_DIR;
	if (!configured) return join(home, ".pi", "agent");
	if (configured === "~") return home;
	return configured.startsWith("~/") ? join(home, configured.slice(2)) : resolve(configured);
}

export function readDeclined(options: PathOptions = {}): Set<string> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(agentDir(options), DECLINED_FILE), "utf8"));
		const list = isRecord(parsed) ? parsed.declined : undefined;
		return new Set(Array.isArray(list) ? list.filter((name): name is string => typeof name === "string") : []);
	} catch {
		return new Set();
	}
}

export function recordDeclined(names: readonly string[], options: PathOptions = {}): string {
	const path = join(agentDir(options), DECLINED_FILE);
	const declined = [...new Set([...readDeclined(options), ...names])].sort();
	writeConfigAtomic(path, JSON.stringify({ declined }, null, 2) + "\n", readSource(existsSync(path) ? realpathSync(path) : path));
	return path;
}

// ---------------------------------------------------------------------------
// Session check
// ---------------------------------------------------------------------------

/** The parts of Pi's ExtensionContext the check uses. */
export interface CheckContext {
	hasUI: boolean;
	cwd: string;
	isProjectTrusted(): boolean;
	sessionManager: { getSessionId(): string };
	ui: {
		select(title: string, options: string[]): Promise<string | undefined>;
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
}

interface SessionState {
	/** Names written to fabric.json and not yet seen declared. */
	pending: string[];
}

export interface ForegroundRegistry {
	wants: Map<string, ForegroundWant>;
	sessions: Map<string, SessionState>;
}

export function sharedRegistry(): ForegroundRegistry {
	const store = globalThis as Record<symbol, ForegroundRegistry | undefined>;
	return (store[REGISTRY_KEY] ??= { wants: new Map(), sessions: new Map() });
}

export interface ForegroundCheckOptions extends PathOptions {
	registry?: ForegroundRegistry;
}

const tilde = (path: string, home: string): string => (path === home || path.startsWith(home + "/") ? "~" + path.slice(home.length) : path);
const list = (names: readonly string[]): string => names.join(", ");

export const ADD_CHOICE = "Add them to fabric.json";
export const LATER_CHOICE = "Not now";
export const NEVER_CHOICE = "Don't ask again for these tools";

/**
 * Register wanted tools and return the handler to call from Pi's agent_end. The first
 * copy to see a session's agent_end checks every registered tool, so several
 * extensions produce one offer. Nothing happens without a UI.
 */
export function createFabricForegroundCheck(
	events: EventBus,
	wants: readonly ForegroundWant[],
	options: ForegroundCheckOptions = {},
): { onAgentEnd(ctx: CheckContext): Promise<void> } {
	const registry = options.registry ?? sharedRegistry();
	for (const want of wants) registry.wants.set(want.name, want);
	const home = options.home ?? homedir();
	const paths: PathOptions = { ...(options.env ? { env: options.env } : {}), home };

	const confirmPending = (ctx: CheckContext, state: SessionState): void => {
		const reply = queryPlacement(events, state.pending);
		if (!reply) return;
		const declared = state.pending.filter((name) => reply.tools[name] === "model");
		if (declared.length !== state.pending.length) return;
		state.pending = [];
		ctx.ui.notify("Fabric now declares " + list(declared) + " to the model.", "info");
	};

	return {
		async onAgentEnd(ctx) {
			if (!ctx.hasUI) return;
			const sessionId = ctx.sessionManager.getSessionId();
			const existing = registry.sessions.get(sessionId);
			if (existing) {
				if (existing.pending.length > 0) confirmPending(ctx, existing);
				return;
			}
			// Claim the session before any await so a second copy's handler skips it.
			const state: SessionState = { pending: [] };
			registry.sessions.set(sessionId, state);

			const declined = readDeclined(paths);
			const candidates = [...registry.wants.values()].filter((want) => !declined.has(want.name));
			if (candidates.length === 0) return;
			const missing = programOnly(queryPlacement(events, candidates.map((want) => want.name)), candidates);
			if (missing.length === 0) return;
			const names = missing.map((want) => want.name);

			const globalPath = join(agentDir(paths), "fabric.json");
			const projectPath = ctx.isProjectTrusted() ? join(ctx.cwd, ".pi", "fabric.json") : undefined;
			let plan: ForegroundPlan;
			try {
				plan = planForegroundEdit({
					global: { path: globalPath, source: readSource(globalPath) },
					project: projectPath ? { path: projectPath, source: readSource(projectPath) } : undefined,
				}, missing);
			} catch (error) {
				plan = { kind: "blocked", reason: error instanceof Error ? error.message : String(error) };
			}
			if (plan.kind === "blocked") {
				ctx.ui.notify("Fabric hides " + list(names) + " from the model, and fabric.json cannot be updated: " + plan.reason + ".", "warning");
				return;
			}
			if (plan.kind === "listed") {
				ctx.ui.notify(
					"fabric.json lists " + list(names) + " in foreground.tools, but Fabric does not declare them yet. Run /fabric reload; if they stay hidden, /fabric status says why.",
					"warning",
				);
				return;
			}
			const where = tilde(plan.path, home);
			const choice = await ctx.ui.select(
				"Fabric's full code mode hides " + list(names) + " from the model, so it can call them only inside fabric_exec. " +
				"Add them to foreground.tools in " + where + (plan.maxTools !== undefined ? " (and raise maxTools to " + plan.maxTools + ")" : "") + "?",
				[ADD_CHOICE, LATER_CHOICE, NEVER_CHOICE],
			);
			if (choice === ADD_CHOICE) {
				try {
					writeConfigAtomic(plan.path, plan.text, plan.source);
				} catch (error) {
					ctx.ui.notify("Could not update " + where + ": " + (error instanceof Error ? error.message : String(error)), "error");
					return;
				}
				state.pending = plan.added;
				ctx.ui.notify("Added " + list(plan.added) + " to foreground.tools in " + where + ". Run /fabric reload to apply it.", "info");
			} else if (choice === NEVER_CHOICE) {
				try {
					const file = recordDeclined(names, paths);
					ctx.ui.notify("Will not ask about " + list(names) + " again. To undo, edit " + tilde(file, home) + ".", "info");
				} catch (error) {
					ctx.ui.notify("Could not record the choice: " + (error instanceof Error ? error.message : String(error)), "error");
				}
			}
		},
	};
}
