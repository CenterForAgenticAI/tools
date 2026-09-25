import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

export type ProcessIdentityVerdict = "match" | "mismatch" | "absent" | "unproven";
export type ProcessPidProbeResult = "present" | "absent" | "unproven";

export interface ProcessIdentityEvidence {
	pid: number;
	startTicks: string;
	bootId: string;
}

export interface ProcessIdentityDependencies {
	readFile: (file: string) => string;
	platform: () => string;
	probePid: (pid: number) => ProcessPidProbeResult;
}

const PROCESS_NONCE_KEY = Symbol.for("pi-delegate.processNonce");
const BOOT_ID_FILE = "/proc/sys/kernel/random/boot_id";
const MAX_START_TICKS_LENGTH = 64;
const MAX_BOOT_ID_LENGTH = 128;
const MAX_PROCESS_NONCE_LENGTH = 256;

function defaultProbePid(pid: number): ProcessPidProbeResult {
	try {
		process.kill(pid, 0);
		return "present";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		if (code === "ESRCH") return "absent";
		if (code === "EPERM") return "present";
		return "unproven";
	}
}

const DEFAULT_DEPENDENCIES: ProcessIdentityDependencies = {
	readFile: (file) => readFileSync(file, "utf8"),
	platform: () => process.platform,
	probePid: defaultProbePid,
};

function dependencies(
	overrides: Partial<ProcessIdentityDependencies> | undefined,
): ProcessIdentityDependencies {
	return { ...DEFAULT_DEPENDENCIES, ...overrides };
}

export function isValidProcessId(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

export function isValidProcessStartTicks(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 &&
		value.length <= MAX_START_TICKS_LENGTH && /^\d+$/.test(value);
}

export function isValidProcessBootId(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_BOOT_ID_LENGTH &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

export function isValidProcessNonce(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 &&
		value.length <= MAX_PROCESS_NONCE_LENGTH && value.trim() === value;
}

/** Parse Linux `/proc/<pid>/stat` field 22 without splitting the parenthesized command name. */
export function parseProcessStartTicks(stat: string): string | undefined {
	if (typeof stat !== "string") return undefined;
	const commEnd = stat.lastIndexOf(")");
	if (commEnd < 0) return undefined;
	const fields = stat.slice(commEnd + 1).trim().split(/\s+/);
	const startTicks = fields[19];
	return isValidProcessStartTicks(startTicks) ? startTicks : undefined;
}

/** Read Linux process start ticks (proc stat field 22) for PID identity. */
export function readProcessStartTicks(
	pid: number,
	overrides?: Partial<ProcessIdentityDependencies>,
): string | undefined {
	if (!isValidProcessId(pid)) return undefined;
	const deps = dependencies(overrides);
	try {
		if (deps.platform() !== "linux") return undefined;
		return parseProcessStartTicks(deps.readFile(`/proc/${pid}/stat`));
	} catch {
		return undefined;
	}
}

function readBootId(deps: ProcessIdentityDependencies): string | undefined {
	try {
		const bootId = deps.readFile(BOOT_ID_FILE).trim();
		return isValidProcessBootId(bootId) ? bootId : undefined;
	} catch {
		return undefined;
	}
}

/** Capture one live Linux PID's birth-and-boot identity. */
export function captureProcessIdentity(
	pid: number,
	overrides?: Partial<ProcessIdentityDependencies>,
): ProcessIdentityEvidence | undefined {
	if (!isValidProcessId(pid)) return undefined;
	const deps = dependencies(overrides);
	try {
		if (deps.platform() !== "linux") return undefined;
		if (deps.probePid(pid) !== "present") return undefined;
	} catch {
		return undefined;
	}
	const startTicks = readProcessStartTicks(pid, deps);
	const bootId = readBootId(deps);
	return startTicks !== undefined && bootId !== undefined
		? { pid, startTicks, bootId }
		: undefined;
}

/**
 * Revalidate a persisted Linux PID generation. Only a proven absence or a complete,
 * readable birth/boot comparison can authorize a stale-owner decision.
 */
export function verifyProcessIdentity(
	evidence: Partial<ProcessIdentityEvidence> | undefined,
	overrides?: Partial<ProcessIdentityDependencies>,
): ProcessIdentityVerdict {
	const deps = dependencies(overrides);
	try {
		if (deps.platform() !== "linux") return "unproven";
	} catch {
		return "unproven";
	}
	if (
		!evidence ||
		!isValidProcessId(evidence.pid) ||
		!isValidProcessStartTicks(evidence.startTicks) ||
		!isValidProcessBootId(evidence.bootId)
	) {
		return "unproven";
	}
	let probe: ProcessPidProbeResult;
	try {
		probe = deps.probePid(evidence.pid);
	} catch {
		return "unproven";
	}
	if (probe === "absent") return "absent";
	if (probe !== "present") return "unproven";
	const observedStartTicks = readProcessStartTicks(evidence.pid, deps);
	const observedBootId = readBootId(deps);
	if (observedStartTicks === undefined || observedBootId === undefined) return "unproven";
	return observedStartTicks === evidence.startTicks && observedBootId === evidence.bootId
		? "match"
		: "mismatch";
}

/** Reload-stable nonce shared by every module instance in this OS process. */
export function getProcessNonce(): string {
	const global = globalThis as Record<symbol, unknown>;
	if (!isValidProcessNonce(global[PROCESS_NONCE_KEY])) {
		global[PROCESS_NONCE_KEY] = randomUUID();
	}
	return global[PROCESS_NONCE_KEY] as string;
}
