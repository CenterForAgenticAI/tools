import { readFile, rename, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { hostname, uptime } from "node:os";
import { join } from "node:path";

/**
 * Who owns a run directory.
 *
 * A process id alone is not evidence of liveness: the operating system reuses
 * process ids, so a record from before a reboot can name a pid that now belongs
 * to something else entirely. `bootToken` is what makes the record trustworthy —
 * it changes on every boot, so a record carrying a different one cannot describe
 * a living owner however recent its heartbeat looks.
 */
export interface OwnerRecord {
	readonly runId: string;
	readonly pid: number;
	readonly bootToken: string;
	readonly host: string;
	readonly startedAt: string;
	readonly heartbeatAt: string;
}

export class RunOwnedError extends Error {
	readonly code = "RUN-ALREADY-OWNED" as const;
	readonly owner: OwnerRecord;

	constructor(owner: OwnerRecord, detail: string) {
		super(detail);
		this.name = "RunOwnedError";
		this.owner = owner;
	}
}

export interface OwnershipOptions {
	/** How old a heartbeat may be before the owner counts as gone. */
	readonly staleAfterMs?: number;
	readonly heartbeatEveryMs?: number;
	readonly now?: () => Date;
	readonly bootToken?: string;
	readonly pid?: number;
	/** Overridable so a test can describe a pid it does not own. */
	readonly isAlive?: (pid: number) => boolean;
}

export const DEFAULT_STALE_AFTER_MS = 30_000;

/** Boot-unique, so a recycled process id cannot masquerade as a live owner. */
export function bootToken(): string {
	try {
		return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
	} catch {
		// Portable fallback: the instant this machine booted, to the second.
		return `uptime-${Math.floor(Date.now() / 1000 - uptime())}`;
	}
}

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (error) { return (error as { code?: string }).code === "EPERM"; }
}

export function ownerPath(directory: string): string {
	return join(directory, "owner.json");
}

/** Why a run directory may be claimed, or may not. */
export type OwnershipVerdict =
	| { kind: "free" }
	| { kind: "takeover"; reason: "stale-heartbeat" | "owner-gone" | "other-boot"; previous: OwnerRecord }
	| { kind: "owned"; owner: OwnerRecord };

export function judge(record: OwnerRecord | undefined, options: OwnershipOptions = {}): OwnershipVerdict {
	if (!record) return { kind: "free" };
	const now = (options.now ?? (() => new Date()))().getTime();
	const token = options.bootToken ?? bootToken();
	const isAlive = options.isAlive ?? alive;
	// A record from another boot cannot describe a living process, whatever it claims.
	if (record.bootToken !== token) return { kind: "takeover", reason: "other-boot", previous: record };
	if (!isAlive(record.pid)) return { kind: "takeover", reason: "owner-gone", previous: record };
	const age = now - new Date(record.heartbeatAt).getTime();
	if (age >= (options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS)) return { kind: "takeover", reason: "stale-heartbeat", previous: record };
	return { kind: "owned", owner: record };
}

export async function readOwner(directory: string): Promise<OwnerRecord | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(ownerPath(directory), "utf8"));
		if (!parsed || typeof parsed !== "object") return undefined;
		const record = parsed as Partial<OwnerRecord>;
		if (typeof record.pid !== "number" || typeof record.bootToken !== "string" || typeof record.heartbeatAt !== "string") return undefined;
		return record as OwnerRecord;
	} catch {
		// No record, or one too damaged to be evidence of anything.
		return undefined;
	}
}

/**
 * The tier-T2 single-writer guard. One runner owns a run directory at a time;
 * a second refuses to start while the owner is live, and takes over only once
 * the owner's heartbeat is stale, its process is gone, or the machine rebooted.
 *
 * It does not fence side effects a node has already emitted. Nothing can
 * ([0006](../../.spec/0006-runtime-state-and-durability.md) §4). What it does
 * prevent is two runners writing one journal.
 */
export class RunOwnership {
	readonly directory: string;
	readonly record: OwnerRecord;
	readonly takeover: { reason: "stale-heartbeat" | "owner-gone" | "other-boot"; previous: OwnerRecord } | undefined;
	private readonly options: OwnershipOptions;
	private timer: ReturnType<typeof setInterval> | undefined;

	private constructor(directory: string, record: OwnerRecord, options: OwnershipOptions, takeover?: RunOwnership["takeover"]) {
		this.directory = directory;
		this.record = record;
		this.options = options;
		this.takeover = takeover;
	}

	/** Claims the run directory, or throws `RunOwnedError` when a live owner holds it. */
	static async acquire(directory: string, runId: string, options: OwnershipOptions = {}): Promise<RunOwnership> {
		const existing = await readOwner(directory);
		const verdict = judge(existing, options);
		if (verdict.kind === "owned") {
			throw new RunOwnedError(verdict.owner, `Run ${runId} is owned by pid ${verdict.owner.pid} on ${verdict.owner.host}, last seen ${verdict.owner.heartbeatAt}. Refusing to start a second runner.`);
		}
		const now = (options.now ?? (() => new Date()))().toISOString();
		const record: OwnerRecord = {
			runId,
			pid: options.pid ?? process.pid,
			bootToken: options.bootToken ?? bootToken(),
			host: hostname(),
			startedAt: now,
			heartbeatAt: now,
		};
		const ownership = new RunOwnership(directory, record, options, verdict.kind === "takeover" ? { reason: verdict.reason, previous: verdict.previous } : undefined);
		await ownership.write(record);
		return ownership;
	}

	private async write(record: OwnerRecord): Promise<void> {
		// Atomic replace, so a reader never sees a half-written record.
		const temporary = `${ownerPath(this.directory)}.${record.pid}.tmp`;
		await writeFile(temporary, JSON.stringify(record), "utf8");
		await rename(temporary, ownerPath(this.directory));
	}

	/** Refreshes the heartbeat once. */
	async beat(): Promise<void> {
		await this.write({ ...this.record, heartbeatAt: (this.options.now ?? (() => new Date()))().toISOString() });
	}

	/** Starts refreshing the heartbeat in the background until `release`. */
	start(): void {
		if (this.timer) return;
		const every = this.options.heartbeatEveryMs ?? Math.max(1000, Math.floor((this.options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS) / 3));
		this.timer = setInterval(() => { void this.beat().catch(() => undefined); }, every);
		this.timer.unref?.();
	}

	/**
	 * True while the record on disk still names this runner.
	 *
	 * Checked before a commit, because takeover cannot be made perfectly safe: an
	 * owner that was merely suspended — a stopped process, a suspended laptop —
	 * has a stale heartbeat and may wake up still believing it owns the run. This
	 * is how it finds out that it does not.
	 */
	async stillOwner(): Promise<boolean> {
		const current = await readOwner(this.directory);
		return current?.pid === this.record.pid && current.bootToken === this.record.bootToken && current.startedAt === this.record.startedAt;
	}

	async release(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		if (await this.stillOwner()) await rm(ownerPath(this.directory), { force: true });
	}
}
