import { AsyncLocalStorage } from "node:async_hooks";

import { TASK_ATTEMPT_ENV, TASKS_SEED_ENV } from "./task-seam.js";

/** Public per-invocation environment patch. `null` explicitly unsets a key. */
export type EnvOverrides = Readonly<Record<string, string | null>>;

/**
 * Delegate-owned environment variables. Caller patches may not replace or
 * remove these because they carry lineage, routing, or child-process control.
 */
export const PROTECTED_ENV_KEYS = new Set<string>([
	"PI_DELEGATE_CHILD",
	"PI_CODING_AGENT_DIR",
	"PI_DELEGATE_CONTROL_SECRET",
	"PI_DELEGATE_OWNER_SESSION_ID",
	"PI_DELEGATE_CHAIN_DIR",
	"PI_DELEGATE_LINEAGE_DEPTH",
	"PI_DELEGATE_LINEAGE_CHAIN",
	"PI_DELEGATE_LINEAGE_EFFECTIVE_MAX",
	"PI_DELEGATE_LINEAGE_RUN_ID",
	"PI_DELEGATE_LINEAGE_ROOT_RUN_ID",
	"PI_DELEGATE_LINEAGE_CHILD_INDEX",
	"PI_DELEGATE_LINEAGE_CAP_TOKEN",
	"PI_DELEGATE_LINEAGE_PUBKEY",
	"PI_DELEGATE_THINKING_POLICY_V1",
	// The worker tool scope carries control-action grants (#265). Caller-supplied
	// env must not be able to forge a wider grant map, nor unset it to fall back
	// to unrestricted; it is injected only by delegate-owned transport.
	"PI_DELEGATE_WORKER_TOOL_SCOPE_V1",
	TASKS_SEED_ENV,
	TASK_ATTEMPT_ENV,
	// Compatibility lineage names used by pi-subagents consumers.
	"PI_SUBAGENT_PARENT_DEPTH",
	"PI_SUBAGENT_PARENT_PATH",
	"PI_SUBAGENT_PARENT_RUN_ID",
	"PI_SUBAGENT_PARENT_ROOT_RUN",
	"PI_SUBAGENT_PARENT_CHILD_IDX",
	// Agent-root routing used by CLI/child discovery.
	"PI_AGENT_DIR",
	"PI_SUBAGENT_RUNTIME_ROOT",
]);

function isEnvKey(key: string): boolean {
	return key.length > 0 && !key.includes("=") && !key.includes("\u0000");
}

function isProtectedEnvKey(key: string): boolean {
	const normalized = key.toUpperCase();
	return (
		PROTECTED_ENV_KEYS.has(key) ||
		PROTECTED_ENV_KEYS.has(normalized) ||
		normalized.startsWith("PI_DELEGATE_LINEAGE_") ||
		normalized.startsWith("PI_SUBAGENT_PARENT_") ||
		normalized.startsWith("PI_DELEGATE_CONTROL_")
	);
}

/** Return a validated, protected-key-filtered copy of a public patch. */
export function normalizeEnvOverrides(value: unknown): Record<string, string | null> {
	if (value === undefined) return {};
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("env must be an object mapping variable names to strings or null");
	}
	const out: Record<string, string | null> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (!isEnvKey(key)) throw new TypeError(`env contains an invalid variable name: ${JSON.stringify(key)}`);
		if (isProtectedEnvKey(key)) continue;
		if (raw !== null && typeof raw !== "string") {
			throw new TypeError(`env.${key} must be a string or null`);
		}
		if (typeof raw === "string" && raw.includes("\u0000")) {
			throw new TypeError(`env.${key} contains a NUL byte`);
		}
		out[key] = raw;
	}
	return out;
}

/** Compose default and invocation patches; later layers win, including null. */
export function mergeEnvOverrides(...layers: Array<EnvOverrides | undefined>): Record<string, string | null> {
	const out: Record<string, string | null> = {};
	for (const layer of layers) {
		if (!layer) continue;
		for (const [key, value] of Object.entries(normalizeEnvOverrides(layer))) out[key] = value;
	}
	return out;
}

/** Materialize a patch over the current process environment for a child spawn. */
export function materializeEnv(overrides?: EnvOverrides): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) out[key] = value;
	}
	for (const [key, value] of Object.entries(mergeEnvOverrides(overrides))) {
		if (value === null) delete out[key];
		else out[key] = value;
	}
	return out;
}

/** Convert a patch to Node's spawn-env shape without exposing unrelated keys. */
export function spawnEnvPatch(overrides?: EnvOverrides): Record<string, string | undefined> {
	const out: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(mergeEnvOverrides(overrides))) out[key] = value ?? undefined;
	return out;
}

interface EnvFrame {
	overrides: Record<string, string | null>;
}

const envStorage = new AsyncLocalStorage<EnvFrame>();
const nativeProcessEnv = process.env;

/**
 * Make process.env reads request-scoped without serializing concurrent direct
 * workers. The proxy is transparent when no delegate env frame is active.
 * Writes remain process-global, as they are for Node's native process.env.
 */
const envProxy = new Proxy(nativeProcessEnv, {
	get(target, property, receiver) {
		if (typeof property === "string") {
			const override = envStorage.getStore()?.overrides;
			if (override && Object.prototype.hasOwnProperty.call(override, property)) {
				return override[property] ?? undefined;
			}
		}
		return Reflect.get(target, property, receiver);
	},
	set(target, property, value) {
		return Reflect.set(target, property, value, target);
	},
	deleteProperty(target, property) {
		return Reflect.deleteProperty(target, property);
	},
	has(target, property) {
		if (typeof property === "string") {
			const override = envStorage.getStore()?.overrides;
			if (override && Object.prototype.hasOwnProperty.call(override, property)) {
				return override[property] !== null;
			}
		}
		return Reflect.has(target, property);
	},
	ownKeys(target) {
		const keys = new Set(Reflect.ownKeys(target));
		const override = envStorage.getStore()?.overrides;
		if (override) {
			for (const [key, value] of Object.entries(override)) {
				if (value === null) keys.delete(key);
				else keys.add(key);
			}
		}
		return [...keys];
	},
	getOwnPropertyDescriptor(target, property) {
		if (typeof property === "string") {
			const override = envStorage.getStore()?.overrides;
			if (override && Object.prototype.hasOwnProperty.call(override, property)) {
				if (override[property] === null) return undefined;
				return { configurable: true, enumerable: true, writable: true, value: override[property] };
			}
		}
		return Reflect.getOwnPropertyDescriptor(target, property);
	},
});

if (process.env === nativeProcessEnv) {
	Object.defineProperty(process, "env", {
		configurable: true,
		enumerable: true,
		writable: true,
		value: envProxy,
	});
}

/** Run an in-process worker under its effective environment overlay. */
export function withEnvOverrides<T>(overrides: EnvOverrides | undefined, fn: () => T): T {
	const parent = envStorage.getStore()?.overrides;
	const effective = { ...parent, ...mergeEnvOverrides(overrides) };
	return envStorage.run({ overrides: effective }, fn);
}

/**
 * Apply delegate-owned variables for an internal child preflight only.
 * Public `env` patches must continue through `withEnvOverrides`, which filters
 * these keys; this seam is reserved for the runner's trusted child simulation.
 */
export function withTrustedEnvOverrides<T>(
	overrides: Readonly<Record<string, string | null>>,
	fn: () => T,
): T {
	const parent = envStorage.getStore()?.overrides;
	return envStorage.run({ overrides: { ...parent, ...overrides } }, fn);
}

/** Parse management/frontmatter input while preserving explicit null unsets. */
export function parseEnvOverrides(value: unknown, field = "env"): Record<string, string | null> | undefined {
	if (value === undefined) return undefined;
	try {
		return normalizeEnvOverrides(value);
	} catch (error) {
		throw new TypeError(`${field} ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}
