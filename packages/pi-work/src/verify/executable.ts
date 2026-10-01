import { access, realpath } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { isEnvironmentVariableList } from "../schema/environment.js";
import { inheritedValuesSnapshot, type InheritedValuesSnapshot } from "./output.js";

export type VerifierExecutable = "git" | "sh" | "systemd-run" | "systemctl";

const executableCandidates: Readonly<Record<VerifierExecutable, readonly string[]>> = {
	git: ["/usr/local/bin/git", "/usr/bin/git", "/bin/git"],
	sh: ["/bin/sh", "/usr/bin/sh"],
	"systemd-run": ["/usr/bin/systemd-run", "/bin/systemd-run"],
	systemctl: ["/usr/bin/systemctl", "/bin/systemctl"],
};

/** Error raised when a verifier-owned executable is not available at a fixed path. */
export class ExecutableResolutionError extends Error {
	readonly executable: VerifierExecutable;

	constructor(executable: VerifierExecutable) {
		super(`cannot resolve verifier executable ${executable} at a fixed absolute path`);
		this.name = "ExecutableResolutionError";
		this.executable = executable;
	}
}

/** Resolve only from fixed system locations; caller PATH is never consulted. */
export async function resolveVerifierExecutable(executable: VerifierExecutable): Promise<string> {
	for (const candidate of executableCandidates[executable]) {
		try {
			const resolved = await realpath(candidate);
			if (!path.isAbsolute(resolved)) continue;
			await access(resolved, fsConstants.X_OK);
			return resolved;
		} catch {
			// Try the next fixed location.
		}
	}
	throw new ExecutableResolutionError(executable);
}

/** Capture only the variables required to reach the systemd user bus. */
export function captureSystemdEnvironment(): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const name of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] as const) {
		const value = process.env[name];
		if (value !== undefined) environment[name] = value;
	}
	return environment;
}

/** Copy only declared variables into the command launcher; do not inherit arbitrary host settings. */
export function captureEvidenceEnvironment(names: unknown, snapshot?: InheritedValuesSnapshot): { environment: NodeJS.ProcessEnv; inherited: InheritedValuesSnapshot; missing: readonly string[]; short: readonly string[]; valid: boolean } {
	const environment = captureSystemdEnvironment();
	if (!isEnvironmentVariableList(names)) return { environment, inherited: inheritedValuesSnapshot([]), missing: [], short: [], valid: false };
	const values: string[] = [];
	const named: Record<string, string> = {};
	const missing: string[] = [];
	const short: string[] = [];
	for (const name of names ?? []) {
		const value = snapshot === undefined ? process.env[name] : snapshot.named[name];
		if (value === undefined) missing.push(name);
		else {
			if (value.length > 0) { values.push(value); named[name] = value; }
			if (value.length < 8) short.push(name);
			else environment[name] = value;
		}
	}
	return { environment, inherited: inheritedValuesSnapshot(values, named), missing, short, valid: true };
}

/** Fallback PATH for the authored command, which is evidence rather than verifier authority. */
export function captureAuthoredPath(): string {
	return process.env.PATH && process.env.PATH.length > 0
		? process.env.PATH
		: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
}

export function isAbsoluteExecutable(value: string): boolean {
	return path.isAbsolute(value);
}

/** Refuse a caller PATH that exposes a different executable before the fixed verifier path. */
export async function pathShadowsExecutable(executable: VerifierExecutable, resolved: string, authoredPath: string): Promise<boolean> {
	for (const directory of authoredPath.split(path.delimiter)) {
		if (directory.length === 0) continue;
		const candidate = path.join(directory, executable);
		try {
			const canonical = await realpath(candidate);
			await access(canonical, fsConstants.X_OK);
			if (canonical === resolved) return false;
			return true;
		} catch {
			// Missing PATH entries do not shadow the fixed executable.
		}
	}
	return false;
}
