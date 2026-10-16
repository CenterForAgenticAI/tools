import { appendParityRecords, type ParityDiff, type ParityRecord } from "./records.js";

/** Bounds on what the shadow recorder may hold in memory and keep outstanding. */
export interface FoldParityLimits {
	/** Estimated bytes held by branch snapshots, call inputs and side-file snapshots. */
	readonly maxRetainedBytes?: number;
	/** Branch snapshots held at once: pending calls, queued comparisons and next-request previews. */
	readonly maxSnapshots?: number;
	/** Call identities held at once, per recorder: started calls plus completed calls awaiting a provider request. */
	readonly maxCalls?: number;
	/** Outstanding work: started calls holding a snapshot, plus queued or writing jobs, until their append completes. */
	readonly maxQueued?: number;
}
export const DEFAULT_PARITY_LIMITS: Required<FoldParityLimits> = {
	maxRetainedBytes: 128 * 1024 * 1024,
	maxSnapshots: 8,
	maxCalls: 1_000,
	maxQueued: 1_000,
};
export interface ParityRetention {
	readonly bytes: number;
	readonly snapshots: number;
	readonly calls: number;
	readonly queued: number;
}
export type BudgetLimit = "bytes" | "snapshots" | "calls" | "queue";
export function budgetDiff(limit: BudgetLimit, detail?: string): ParityDiff {
	return { kind: "too-large", reason: `shadow recorder budget exceeded (${limit})${detail ? `; ${detail}` : ""}` };
}

const isPlainObject = (value: object) => {
	const proto = Object.getPrototypeOf(value) as unknown;
	return proto === Object.prototype || proto === null;
};
/**
 * Upper-bound estimate of the heap a structuredClone of `value` allocates, without allocating a copy.
 * Strings count two bytes per code unit. An array-buffer view counts its whole backing buffer, because
 * structuredClone copies the buffer, not the view's slice. Maps and Sets count their entries. Any other
 * non-plain object (class instances, errors, functions, symbols, ...) is not sized and returns Infinity,
 * so the caller rejects it before copying. Stops as soon as the total passes `limit`, so the walk is
 * bounded by the budget even for very large or cyclic values.
 */
export function estimateBytes(value: unknown, limit: number): number {
	let total = 0;
	const stack: unknown[] = [value];
	while (stack.length) {
		if (total > limit) return total;
		const item = stack.pop();
		if (typeof item === "string") total += 16 + item.length * 2;
		else if (item === null || item === undefined || typeof item === "number" || typeof item === "boolean") total += 8;
		else if (typeof item === "bigint") total += 16 + Math.ceil(item.toString(16).length / 2);
		else if (typeof item !== "object") return Number.POSITIVE_INFINITY;
		else if (ArrayBuffer.isView(item)) total += 64 + item.buffer.byteLength;
		else if (item instanceof ArrayBuffer || item instanceof SharedArrayBuffer) total += 64 + item.byteLength;
		else if (item instanceof Date) total += 32;
		else if (item instanceof Map) {
			total += 32 + item.size * 16;
			for (const [key, child] of item) stack.push(key, child);
		} else if (item instanceof Set) {
			total += 32 + item.size * 8;
			for (const child of item) stack.push(child);
		} else if (Array.isArray(item)) {
			total += 16 + item.length * 8;
			for (const child of item) stack.push(child);
		} else if (isPlainObject(item)) {
			total += 32;
			for (const [key, child] of Object.entries(item)) {
				total += 8 + key.length * 2;
				stack.push(child);
			}
		} else return Number.POSITIVE_INFINITY;
	}
	return total;
}

export interface Lease {
	readonly bytes: number;
	/** Idempotent. */
	release(): void;
}
/** Split one lease between several owners; the underlying lease is released when every owner has released. */
export function shareLease(lease: Lease, owners: number): Lease[] {
	let remaining = owners;
	return Array.from({ length: owners }, () => {
		let released = false;
		return {
			bytes: lease.bytes,
			release: () => {
				if (released) return;
				released = true;
				if (--remaining === 0) lease.release();
			},
		};
	});
}

/** Content-holding work: a comparison or preview that has not produced its record yet. */
export interface ParityTask {
	/** Produce the record. May throw; then `failed` supplies the record. */
	run(): ParityRecord;
	failed(): ParityRecord;
	/** The record written instead when the task's session ends before it runs. */
	cancelled(): ParityRecord;
	/** Release the task's content leases. Idempotent. */
	release(): void;
}
export interface ParityJob {
	/** The session state that owns this job; resetting it cancels the job's task. */
	readonly owner: object;
	readonly agentDir: string;
	readonly sessionId: string;
	/** Reservation held until the job's append completes. */
	readonly work: Lease;
	task: ParityRecord | ParityTask;
}
type Append = (agentDir: string, sessionId: string, records: readonly ParityRecord[]) => Promise<void>;
interface DropTarget {
	readonly agentDir: string;
	readonly sessionId: string;
	readonly marker: (toolCallId: string, dropped: number) => ParityRecord;
}

/**
 * Counts retained bytes, snapshots and outstanding work, and runs all recorder jobs on one serial
 * writer. Every lease and work reservation is released at most once. Jobs are reserved from admission
 * until their append completes, so a session reset or runtime replacement cannot hide work that is
 * still alive. At most one append is in progress at a time; overflow is counted, not queued, and one
 * inconclusive marker record states how many records were dropped.
 */
export class ParityBudget {
	readonly limits: Required<FoldParityLimits>;
	bytes = 0;
	snapshots = 0;
	work = 0;
	private readonly queue: ParityJob[] = [];
	private draining = false;
	private idleWaiters: (() => void)[] = [];
	private dropped = 0;
	private dropTarget: DropTarget | undefined;
	private markers = 0;
	constructor(limits: FoldParityLimits = {}, private readonly append: Append = appendParityRecords) {
		this.limits = { ...DEFAULT_PARITY_LIMITS, ...limits };
	}
	get remainingBytes(): number { return Math.max(0, this.limits.maxRetainedBytes - this.bytes); }
	get snapshotsFull(): boolean { return this.snapshots >= this.limits.maxSnapshots; }
	get workFull(): boolean { return this.work >= this.limits.maxQueued; }
	lease(bytes: number, snapshot: boolean): Lease {
		this.bytes += bytes;
		if (snapshot) this.snapshots++;
		let released = false;
		return {
			bytes,
			release: () => {
				if (released) return;
				released = true;
				this.bytes -= bytes;
				if (snapshot) this.snapshots--;
			},
		};
	}
	/** Reserve one unit of outstanding work, or undefined when the work bound is full. */
	reserve(): Lease | undefined {
		if (this.workFull) return undefined;
		this.work++;
		let released = false;
		return { bytes: 0, release: () => { if (!released) { released = true; this.work--; } } };
	}
	enqueue(job: ParityJob): void {
		this.queue.push(job);
		this.kick();
	}
	/** Count a record that could not be queued; the writer reports the count in one marker record. */
	drop(target: DropTarget): void {
		this.dropped++;
		this.dropTarget = target;
		this.kick();
	}
	/** Replace queued tasks owned by `owner` with their small cancellation records and drop their content. */
	cancel(owner: object): void {
		for (const job of this.queue) {
			if (job.owner !== owner || !isTask(job.task)) continue;
			const task = job.task;
			job.task = task.cancelled();
			task.release();
		}
	}
	/** Resolves when no job is queued or being written. */
	idle(): Promise<void> {
		if (!this.draining && !this.queue.length && !this.dropped) return Promise.resolve();
		return new Promise((resolve) => this.idleWaiters.push(resolve));
	}
	private kick(): void {
		if (this.draining) return;
		this.draining = true;
		void this.drain();
	}
	private async drain(): Promise<void> {
		try {
			for (;;) {
				// Off the tool/provider critical path, and yield between jobs.
				await new Promise<void>((resolve) => setImmediate(resolve));
				const job = this.queue.shift();
				if (!job) {
					if (!this.dropped || !this.dropTarget) break;
					const { agentDir, sessionId, marker } = this.dropTarget;
					const record = marker(`recorder-dropped/${++this.markers}`, this.dropped);
					this.dropped = 0;
					this.dropTarget = undefined;
					await this.write(agentDir, sessionId, [record]);
					continue;
				}
				const batch = [job];
				// Ready records for the same file share one append.
				if (!isTask(job.task)) while (this.queue[0] && !isTask(this.queue[0].task) && this.queue[0].agentDir === job.agentDir && this.queue[0].sessionId === job.sessionId) batch.push(this.queue.shift()!);
				try {
					await this.write(job.agentDir, job.sessionId, batch.map(produce));
				} finally {
					for (const item of batch) item.work.release();
				}
			}
		} finally {
			this.draining = false;
			if (this.queue.length || this.dropped) this.kick();
			else this.idleWaiters.splice(0).forEach((resolve) => resolve());
		}
	}
	private async write(agentDir: string, sessionId: string, records: readonly ParityRecord[]): Promise<void> {
		try { await this.append(agentDir, sessionId, records); } catch { /* Diagnostics must never affect a live call, even when the disk is unavailable. */ }
	}
}
const isTask = (task: ParityRecord | ParityTask): task is ParityTask => "run" in task;
/** Run a job's task, release its content before the append, and keep only the small record. */
function produce(job: ParityJob): ParityRecord {
	const task = job.task;
	if (!isTask(task)) return task;
	let record: ParityRecord;
	try { record = task.run(); } catch { record = task.failed(); } finally { task.release(); }
	job.task = record;
	return record;
}

const PROCESS_BUDGET = Symbol.for("pi-context-aware/fold-parity-budget/v2");
/**
 * The budget shared by every recorder in this process. It lives on globalThis so that a Pi runtime
 * replacement, which registers the extension again while the outgoing runtime's work may still be
 * writing, counts against the same bounds. Bump the symbol version when this class's shape changes.
 */
export function processParityBudget(): ParityBudget {
	const holder = globalThis as { [PROCESS_BUDGET]?: ParityBudget };
	return (holder[PROCESS_BUDGET] ??= new ParityBudget(DEFAULT_PARITY_LIMITS));
}
