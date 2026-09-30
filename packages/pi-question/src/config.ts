import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TimeoutPolicy } from "./kernel/expire.ts";
import type { SurfaceName } from "./kernel/select.ts";

export interface PiQuestionConfig {
	timeoutMs: number;
	onTimeout: TimeoutPolicy;
	surfaces: SurfaceName[];
	blockedSignal: boolean;
}

export const DEFAULTS: PiQuestionConfig = {
	timeoutMs: 0,
	onTimeout: "cancel",
	surfaces: ["host", "tui", "dialogs"],
	blockedSignal: true,
};

const POLICIES: readonly TimeoutPolicy[] = ["cancel", "recommended", "error"];
const SURFACES: readonly SurfaceName[] = ["host", "tui", "dialogs"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validate one layer. Returns undefined when any field is invalid (fail closed). */
export function parseLayer(raw: unknown): Partial<PiQuestionConfig> | undefined {
	if (raw === undefined) return {};
	if (!isRecord(raw)) return undefined;
	const out: Partial<PiQuestionConfig> = {};
	if (raw.timeoutMs !== undefined) {
		if (typeof raw.timeoutMs !== "number" || !Number.isFinite(raw.timeoutMs) || raw.timeoutMs < 0) return undefined;
		out.timeoutMs = Math.floor(raw.timeoutMs);
	}
	if (raw.onTimeout !== undefined) {
		const policy = POLICIES.find((p) => p === raw.onTimeout);
		if (!policy) return undefined;
		out.onTimeout = policy;
	}
	if (raw.surfaces !== undefined) {
		if (!Array.isArray(raw.surfaces)) return undefined;
		const list = raw.surfaces.map((s) => SURFACES.find((x) => x === s));
		if (list.some((s) => s === undefined)) return undefined;
		out.surfaces = list as SurfaceName[];
	}
	if (raw.blockedSignal !== undefined) {
		if (typeof raw.blockedSignal !== "boolean") return undefined;
		out.blockedSignal = raw.blockedSignal;
	}
	return out;
}

/** Defaults, then global, then project. A layer that is invalid is ignored with one warning. */
export function mergeConfig(layers: unknown[], warn: (message: string) => void): PiQuestionConfig {
	let config = { ...DEFAULTS };
	for (const layer of layers) {
		const parsed = parseLayer(layer);
		if (!parsed) {
			warn("pi-question: invalid piQuestion settings ignored; using defaults for that layer");
			continue;
		}
		config = { ...config, ...parsed };
	}
	return config;
}

function readKey(file: string): unknown {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		return isRecord(parsed) ? parsed.piQuestion : undefined;
	} catch {
		return undefined;
	}
}

export function loadConfig(agentDir: string, cwd: string, warn: (message: string) => void = () => {}): PiQuestionConfig {
	return mergeConfig([readKey(join(agentDir, "settings.json")), readKey(join(cwd, ".pi", "settings.json"))], warn);
}
