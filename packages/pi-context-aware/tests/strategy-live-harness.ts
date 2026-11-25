/**
 * A fold engine over a synthetic or recorded session, with its handlers captured, for the live strategy tests
 * (pi-context-aware#472). Not a test file itself.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerFoldEngine, type FoldEngineOptions } from "../src/folds/fold-engine.js";
import type { Seeded } from "./strategy-differential-cases.js";
import { removeFixtureDir } from "./fixture-cleanup.js";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

export interface EngineHarness {
	readonly engine: ReturnType<typeof registerFoldEngine>;
	readonly ctx: ExtensionContext;
	readonly fire: (name: string, event?: unknown) => unknown[];
}

/** A temporary agent directory and project with no settings, so the user's own settings never reach a test. */
export function isolatedRoot(t: { after(fn: () => void | Promise<void>): void }): string {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-live-engine-")));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	t.after(async () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		await removeFixtureDir(root);
	});
	return root;
}

/** The fold engine over a seeded session, with its handlers captured. */
export function engineOver(root: string, seeded: Seeded & { readonly usage?: number }, options: FoldEngineOptions, tools: readonly string[] = []): EngineHarness {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		getAllTools: () => tools.map((name) => ({ name, sourceInfo: { path: "builtin:" + name } })),
	} as unknown as ExtensionAPI;
	const engine = registerFoldEngine(pi, { hints: () => seeded.hints, ...options });
	const ctx = {
		cwd: root,
		// A trusted project: an untrusted project's own file sets no fold or strategy leaf (pi-context-aware#525).
		isProjectTrusted: () => true,
		sessionManager: seeded.manager,
		model: { id: "synthetic", contextWindow: seeded.modelContextLimit },
		getContextUsage: () => (seeded.usage === undefined ? undefined : { tokens: seeded.usage, contextWindow: seeded.modelContextLimit }),
		getSystemPrompt: () => "",
		hasUI: false,
	} as unknown as ExtensionContext;
	const fire = (name: string, event: unknown = {}) => (handlers.get(name) ?? []).map((handler) => handler(event, ctx));
	fire("session_start");
	return { engine, ctx, fire };
}
