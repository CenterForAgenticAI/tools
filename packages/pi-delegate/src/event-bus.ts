/**
 * Boundary-crossing filesystem event bus for the delegation tree (spec 0004).
 *
 * ## Why
 *
 * The heartbeat monitor (`src/worker-channel.ts`) watches the IMMEDIATE
 * run's transcript. In a foreground → orchestrator → worker tree the
 * orchestrator's own transcript sits IDLE while its WORKER does the real
 * work; the monitor saw only silence and force-cancelled a healthy
 * orchestrator (~15 min in). The orchestrator's grandchild progress never
 * bubbled up across the run seam.
 *
 * This module is the fix: every run — in-process or detached, at any depth
 * — appends bounded liveness events to a filesystem sink keyed by the
 * ROOT-run-id (the whole tree's anchor). A parent (or the foreground) reads
 * the sink to answer one question for the heartbeat: "is ANY descendant of
 * this run still producing events?" If so, the run is ALIVE and must not
 * be cancelled for silence (REQ-BUS-2).
 *
 * ## id/path scheme (REQ-BUS-5)
 *
 * The bus shares ONE id/path scheme with the lineage substrate (spec 0003):
 * the event-routing ADDRESS is `lineagePath(frame)` from `src/lineage.ts`
 * (`<rootRunId>/<runId>#<childIndex>`), and the sink KEY is the frame's
 * `rootRunId`. There is no second id scheme — the lineage path IS the
 * routing address.
 *
 * ## Relationship to control-events-emission
 *
 * The event payload SHARES its core fields (`kind`, `lineagePath`, `ts`,
 * `fields`) with the flat `control-events-emission` draft (which emits
 * `delegate:control-event` on `pi.events` for ecosystem consumers like
 * monitoring / intercom). They DELIBERATELY share the shape but are DISTINCT
 * transports solving different problems: this bus is the nested, routed,
 * boundary-crossing liveness record for the delegation TREE; the flat
 * emission is a same-process ecosystem signal. Cross-referenced here; NOT
 * merged. [decision: coexist-with-control-events-emission]
 *
 * ## Best-effort discipline (REQ-BUS-4)
 *
 * Event writes are best-effort — same swallow-behind-a-diagnostic DISCIPLINE
 * as the lifecycle diagnostic logger (the earlier comparison to
 * `sweepOldChainDirs` was misleading — that is a readdir+unlink sweep loop,
 * not a write path; issue #9 nit). A write failure
 * (unwritable dir, disk full) is swallowed behind a single throttled
 * diagnostic — appended to the `diagnostics.log` file and echoed to
 * `console.warn` only when `PI_DELEGATE_DEBUG === "1"` (spec 0010), so it
 * never pollutes the user-facing TUI. A contended non-blocking lock attempt
 * is diverted to the append-only pending generation; it never sleeps behind
 * another process. A runaway child is bounded by the caps below (REQ-BUS-6)
 * so it can neither flood the foreground nor fill the disk.
 *
 * ## Sink layout
 *
 *   <agentDir>/extensions/pi-delegate/event-bus/<rootRunId>/events.ndjson
 *
 * Same area as the existing `runs.jsonl` history (NOT the session jsonl),
 * so the record is greppable and survives a reload.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { currentLineageFrame, type DepthFrame } from "./depth-guard.js";
import {
	__resetDelegateDiagnosticsForTests,
	emitDelegateDiagnosticToFile,
} from "./diagnostics.js";
import { deserializeLineage, lineageAncestorPath, lineagePath } from "./lineage.js";
import {
	captureProcessIdentity,
	getProcessNonce,
	isValidProcessBootId,
	isValidProcessNonce,
	isValidProcessStartTicks,
	type ProcessIdentityDependencies,
	verifyProcessIdentity,
} from "./process-identity.js";
import { TASK_LEDGER_FIELD, TASK_PROGRESS_FIELD } from "./task-seam.js";
import {
	ensureOwnerOnlyDirectory,
	ensureOwnerOnlyFile,
	preserveCorruptFile,
	readUtf8File,
	replaceTextFile,
	StateLockTimeoutError,
	tryWithStateFileLock,
} from "./state-io.js";

// ── Bounds (REQ-BUS-6) [decision: bounds-adopt-nicobailon] ──────────────────
//
// Adopted from pi-subagents-nicobailon (github.com/nicobailon/pi-subagents,
// MIT) `runs/shared/nested-events.ts`: a runaway child must not flood the
// foreground or fill disk. On exceed we cap/drop + warn, never flood.

/** Max serialized bytes for a single event line; oversized payloads truncated. */
export const MAX_EVENT_BYTES = 64 * 1024;
/**
 * Max retained events per child (per lineagePath) before further `updated`
 * events coalesce instead of appending. The latest ordinary update survives, as
 * do the latest bounded task-progress and task-ledger snapshots when present.
 * `started` / `completed` terminals always land; only the noisy middle stream
 * is coalesced.
 */
export const MAX_STEPS = 12;
/** Max distinct children (distinct lineagePaths) retained in one sink. */
export const MAX_CHILDREN = 16;

/** Event kinds. `started` on construction, `updated` on activity, `completed` on terminal. */
export type BusEventKind = "started" | "updated" | "completed";

/**
 * One bus event. SHARES the `kind` / `lineagePath` / `ts` / `fields` core
 * with control-events-emission (see module doc) but is a distinct transport.
 * `pid` + `ancestorPath` are bus-specific: `pid` addresses the emitter
 * process, `pidStartTicks`/`pidBootId` prove its birth+boot generation for
 * stale-event renewal, and `ancestorPath` is the emitter's full root→self
 * id-path (`lineageAncestorPath(frame)`) that lets a reader decide whether an
 * emitter is a TRUE DESCENDANT of a given ancestor — the ancestor's own path
 * is a strict PREFIX of the emitter's. (`depth` is
 * retained as a coarse diagnostic but is NOT used for descendant
 * discrimination: a same-root COUSIN at greater depth has a greater depth
 * yet is not a descendant.)
 */
export interface BusEvent {
	/** Stable per-emission identity used to merge crash-recovery generations. */
	eventId?: string;
	/** ms-since-epoch emission time. */
	ts: number;
	/** The emitter's routing address — `lineagePath(frame)` (leaf only). */
	lineagePath: string;
	/**
	 * The emitter's full root→self id-path — `lineageAncestorPath(frame)`, a
	 * `/`-joined chain of `runId#childIndex` segments. TRUE-ancestry key: an
	 * ancestor A is an ancestor of this event iff `ancestorPath` is
	 * `A.ancestorPath` followed by `/`. Optional for forward/backward read
	 * tolerance of pre-field sink lines (treated as non-descendant when absent).
	 */
	ancestorPath?: string;
	kind: BusEventKind;
	/** Emitter pid, for detached-child liveness checks. */
	pid: number;
	/** Optional emitter birth-identity field (`/proc/<pid>/stat` field 22). */
	pidStartTicks?: string;
	/** Optional emitter boot-identity field (`/proc/sys/kernel/random/boot_id`). */
	pidBootId?: string;
	/** Optional process-local nonce for same-process observability. */
	pidNonce?: string;
	/** This node's tree depth — coarse diagnostic only (NOT used for ancestry). */
	depth: number;
	/** Free-form structured detail (e.g. status, active tool). Bounded by MAX_EVENT_BYTES. */
	fields?: Record<string, unknown>;
}

/** Resolve the `event-bus/` runtime root (the parent of every per-root sink). */
function resolveEventBusRoot(agentDir: string): string {
	return path.join(agentDir, "extensions", "pi-delegate", "event-bus");
}

/** Resolve the per-root sink directory under the delegate runtime dir. */
export function resolveEventSinkDir(agentDir: string, rootRunId: string): string {
	return path.join(resolveEventBusRoot(agentDir), rootRunId);
}

/** Resolve the per-root events ndjson file inside the sink dir. */
function resolveEventSinkFile(agentDir: string, rootRunId: string): string {
	return path.join(resolveEventSinkDir(agentDir, rootRunId), "events.ndjson");
}

/**
 * Compact terminal semantics that must survive a bounded status-tail read.
 * Only fixed booleans are persisted: no prompts, errors, fields, or lineage
 * values can cross into status metadata through this sidecar.
 */
export interface BusTerminalSummary {
	paused: boolean;
	steered: boolean;
}

function resolveTerminalFactFile(
	agentDir: string,
	rootRunId: string,
	fact: keyof BusTerminalSummary,
): string {
	return path.join(resolveEventSinkDir(agentDir, rootRunId), `terminal-${fact}`);
}

/** Read the two fixed-size, monotonic terminal fact sidecars. */
export function readBusTerminalSummary(
	agentDir: string,
	rootRunId: string,
): BusTerminalSummary {
	// Independent monotonic sentinels make cross-process paused/steered writes
	// commutative; no read-modify-write step can erase the other fact.
	const hasFact = (fact: keyof BusTerminalSummary): boolean => {
		try {
			return fs.existsSync(resolveTerminalFactFile(agentDir, rootRunId, fact));
		} catch {
			return false;
		}
	};
	return {
		paused: hasFact("paused"),
		steered: hasFact("steered"),
	};
}

/** Create one idempotent, fixed-size terminal fact across competing writers. */
function writeBusTerminalFact(
	agentDir: string,
	rootRunId: string,
	fact: keyof BusTerminalSummary,
): void {
	const file = resolveTerminalFactFile(agentDir, rootRunId, fact);
	try {
		fs.writeFileSync(file, "1", {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
	}
	ensureOwnerOnlyFile(file);
}

/** Persist only paused/steered terminal facts; all other event fields stay out. */
function updateBusTerminalSummary(
	agentDir: string,
	rootRunId: string,
	event: BusEvent,
): void {
	if (event.kind !== "completed") return;
	const semanticKind = event.fields?.kind;
	const paused = semanticKind === "paused";
	const steered = semanticKind === "steered" && event.fields?.phase === "terminal";
	if (!paused && !steered) return;
	if (paused) writeBusTerminalFact(agentDir, rootRunId, "paused");
	if (steered) writeBusTerminalFact(agentDir, rootRunId, "steered");
}

/**
 * Resolve the shared diagnostics log file. It sits at the `event-bus/` ROOT
 * (a FILE, sibling to the per-rootRunId sink DIRECTORIES) so it is exempt from
 * `sweepOldEventSinks` (which removes only directories) — hence the explicit
 * size cap below (REQ-BUSWARN-5).
 */
function resolveDiagnosticsLogFile(agentDir: string): string {
	return path.join(resolveEventBusRoot(agentDir), "diagnostics.log");
}

// ── Diagnostics-log channel (spec 0010, REQ-BUSWARN-1..5) ───────────────────
//
// The sink-bounds bookkeeping messages (MAX_EVENT_BYTES truncate / MAX_CHILDREN
// drop / MAX_STEPS coalesce / append-failed) are routine, healthy trims that
// announce NOTHING actionable. In a pi TUI a raw `console.warn` is captured
// into the user-facing stream, so these benign messages looked like errors
// during normal active runs. The fix is the CHANNEL, not the rate: route them
// to a best-effort diagnostics FILE log by default, and echo to `console.warn`
// ONLY when `PI_DELEGATE_DEBUG === "1"` (opt-in active debugging — deliberately
// stricter than the bare-truthiness `GRAFT_DEBUG_WORKER` precedent in the
// runners). The per-key 60s throttle (now in the shared core) stays in FRONT
// of the channel so the file log doesn't grow without bound from a chatty
// child either.

/**
 * Best-effort diagnostics sink for a throttled bus-bookkeeping message
 * (REQ-BUSWARN-1/2/5). Thin caller of the shared spec-0017 diagnostics core
 * (`emitDelegateDiagnosticToFile`) under `throttleKey="bus-warn"`: ALWAYS
 * appends the (throttled) message to the shared `event-bus/diagnostics.log`;
 * additionally echoes to `console.warn` only while `PI_DELEGATE_DEBUG === "1"`.
 * Keeps the explicit `agentDir` param (threaded by `appendBusEvent`) so the
 * 0010 file-path test seam is preserved. NEVER throws into the caller
 * (REQ-BUSWARN-3 — the append-failed site calls this from inside its own catch).
 */
function logBusDiagnostic(agentDir: string, message: string): void {
	const file = agentDir ? resolveDiagnosticsLogFile(agentDir) : "";
	emitDelegateDiagnosticToFile(file, `event-bus: ${message}`, {
		throttleKey: "bus-warn",
		level: "warn",
	});
}

/**
 * Test-only: reset the warn throttle so a test can assert a fresh diagnostic.
 * Delegates to the shared diagnostics reset (the throttle state now lives in
 * the spec-0017 core); the file itself is per-`agentDir` (the test's tmp dir)
 * so it needs no reset here.
 */
export function __resetEventBusWarnForTests(): void {
	__resetDelegateDiagnosticsForTests();
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBusEventRecord(value: unknown): value is BusEvent {
	if (!isRecordValue(value)) return false;
	const record = value;
	const kind = record.kind;
	return (
		typeof record.ts === "number" &&
		typeof record.lineagePath === "string" &&
		(kind === "started" || kind === "updated" || kind === "completed") &&
		(record.eventId === undefined || typeof record.eventId === "string") &&
		typeof record.pid === "number" &&
		(record.pidStartTicks === undefined || isValidProcessStartTicks(record.pidStartTicks)) &&
		(record.pidBootId === undefined || isValidProcessBootId(record.pidBootId)) &&
		(record.pidNonce === undefined || isValidProcessNonce(record.pidNonce)) &&
		typeof record.depth === "number" &&
		(record.ancestorPath === undefined || typeof record.ancestorPath === "string") &&
		(record.fields === undefined || (typeof record.fields === "object" && record.fields !== null && !Array.isArray(record.fields)))
	);
}

function preserveEventCorruptForRewrite(file: string): void {
	if (preserveCorruptFile(file)) return;
	if (readUtf8File(file).kind !== "absent") {
		throw new Error("event sink is corrupt and could not be preserved before replacement");
	}
}

interface SinkScan {
	events: BusEvent[];
	/** Raw malformed lines remain available instead of taking the sink offline. */
	malformedLines: string[];
}

function pendingEventFile(file: string): string {
	return `${file}.pending`;
}

function pendingOffsetFile(file: string): string {
	return `${pendingEventFile(file)}.offset`;
}

function eventGenerationFiles(file: string): string[] {
	const directory = path.dirname(file);
	const base = path.basename(file);
	const prefixes = [`${base}.pending.rewrite-`, `${base}.rewrite-`];
	try {
		return fs.readdirSync(directory)
			.filter((name) => prefixes.some((prefix) => name.startsWith(prefix)))
			.map((name) => path.join(directory, name));
	} catch {
		return [];
	}
}

function eventIdentity(event: BusEvent): string {
	return event.eventId ? `id:${event.eventId}` : `legacy:${JSON.stringify(event)}`;
}

function mergeSinkScans(scans: readonly SinkScan[]): SinkScan {
	const events: BusEvent[] = [];
	const seen = new Set<string>();
	const malformedLines: string[] = [];
	for (const scan of scans) {
		for (const event of scan.events) {
			const identity = eventIdentity(event);
			if (seen.has(identity)) continue;
			seen.add(identity);
			events.push(event);
		}
		malformedLines.push(...scan.malformedLines);
	}
	return { events, malformedLines };
}

function scanLines(contents: string): SinkScan {
	const events: BusEvent[] = [];
	const malformedLines: string[] = [];
	for (const line of contents.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (isBusEventRecord(parsed)) events.push(parsed);
			else malformedLines.push(trimmed);
		} catch {
			malformedLines.push(trimmed);
		}
	}
	return { events, malformedLines };
}

function scanSinkSource(file: string): SinkScan {
	const result = readUtf8File(file);
	if (result.kind === "absent") return { events: [], malformedLines: [] };
	if (result.kind === "corrupt") {
		preserveEventCorruptForRewrite(file);
		return { events: [], malformedLines: [] };
	}
	return scanLines(result.value);
}

interface PendingSinkScan extends SinkScan {
	/** Byte offset through which a successful canonical rewrite consumed data. */
	consumedBytes: number;
}

function pendingConsumedOffset(file: string, size: number): number {
	const result = readUtf8File(pendingOffsetFile(file));
	if (result.kind !== "ok") return 0;
	const offset = Number.parseInt(result.value.trim(), 10);
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) return 0;
	return offset;
}

/**
 * Read only complete newline-terminated records from the append-only fallback
 * generation. The generation is never renamed or truncated while writers can
 * hold an open descriptor. A rewrite acknowledges only complete raw bytes;
 * an unterminated prefix remains for the next probe to finish and parse.
 */
function scanPendingSource(file: string): PendingSinkScan {
	const pending = pendingEventFile(file);
	let bytes: Buffer;
	try {
		bytes = fs.readFileSync(pending);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
			return { events: [], malformedLines: [], consumedBytes: 0 };
		}
		preserveEventCorruptForRewrite(pending);
		return { events: [], malformedLines: [], consumedBytes: 0 };
	}
	const completeEnd = bytes.lastIndexOf(0x0a) + 1;
	let offset = pendingConsumedOffset(file, bytes.byteLength);
	if (offset > completeEnd || (offset > 0 && bytes[offset - 1] !== 0x0a)) offset = 0;
	const suffix = bytes.subarray(offset, completeEnd).toString("utf8");
	const scanned = scanLines(suffix);
	return { ...scanned, consumedBytes: completeEnd };
}

/**
 * Read + parse the existing sink lines (best-effort). A malformed line is
 * ignored as an event but remains in place; valid lines stay readable on every
 * subsequent probe, so one bad producer record cannot quarantine the liveness
 * sink. The append path reports and retains malformed lines during rewrites.
 */
function readSinkScan(file: string): SinkScan {
	const main = scanSinkSource(file);
	const pending = scanPendingSource(file);
	const generations = eventGenerationFiles(file).map((generation) => scanSinkSource(generation));
	return mergeSinkScans([main, pending, ...generations]);
}

/**
 * Serialize an event to a bounded NDJSON line. Oversized payloads (over
 * `MAX_EVENT_BYTES`) have their `fields` replaced with a truncation marker
 * so the line stays under the cap (REQ-BUS-6). The `kind` / `lineagePath` /
 * `ts` / `pid` / `depth` core is never dropped.
 *
 * Pure (no IO): when a truncation fires, the bookkeeping `warning` is RETURNED
 * to the caller rather than emitted here (REQ-BUSWARN-4), so the single
 * diagnostics-log write stays confined to `appendBusEvent`.
 */
function serializeBounded(event: BusEvent): { line: string; warning?: string } {
	let line = JSON.stringify(event);
	if (Buffer.byteLength(line, "utf-8") > MAX_EVENT_BYTES) {
		const truncated: BusEvent = {
			...(event.eventId !== undefined ? { eventId: event.eventId } : {}),
			ts: event.ts,
			lineagePath: event.lineagePath,
			...(event.ancestorPath !== undefined ? { ancestorPath: event.ancestorPath } : {}),
			kind: event.kind,
			pid: event.pid,
			...(event.pidStartTicks !== undefined ? { pidStartTicks: event.pidStartTicks } : {}),
			...(event.pidBootId !== undefined ? { pidBootId: event.pidBootId } : {}),
			...(event.pidNonce !== undefined ? { pidNonce: event.pidNonce } : {}),
			depth: event.depth,
			fields: { truncated: true, originalBytes: Buffer.byteLength(line, "utf-8") },
		};
		line = JSON.stringify(truncated);
		return {
			line,
			warning: `event for ${event.lineagePath} exceeded ${MAX_EVENT_BYTES}B; truncated fields`,
		};
	}
	return { line };
}

/**
 * Apply the children + steps caps to the retained event set (REQ-BUS-6),
 * returning the bounded set to rewrite plus any bookkeeping `warnings`. Pure
 * (no IO) so it is unit-testable: when a cap fires, the warning STRING is
 * returned to `appendBusEvent` (the one IO fn) rather than emitted here
 * (REQ-BUSWARN-4), so this helper performs no logging.
 *
 *   - MAX_CHILDREN: when more than `MAX_CHILDREN` distinct lineagePaths are
 *     present, drop the events of the OLDEST children (by their earliest
 *     event ts) — the freshest children (the ones a liveness check cares
 *     about) are retained.
 *   - MAX_STEPS: per child, the `started` + `completed` terminals are always
 *     kept; the `updated` stream is COALESCED to a single rolling (latest)
 *     entry once a child exceeds `MAX_STEPS` retained events.
 */
export function applyBounds(events: BusEvent[]): { events: BusEvent[]; warnings: string[] } {
	const warnings: string[] = [];
	// Group by child lineagePath, preserving first-seen ts for child ranking.
	const byChild = new Map<string, BusEvent[]>();
	for (const ev of events) {
		const bucket = byChild.get(ev.lineagePath);
		if (bucket) bucket.push(ev);
		else byChild.set(ev.lineagePath, [ev]);
	}

	// MAX_CHILDREN — keep the freshest children by latest activity.
	if (byChild.size > MAX_CHILDREN) {
		const ranked = [...byChild.entries()].sort((a, b) => {
			const aLatest = Math.max(...a[1].map((e) => e.ts));
			const bLatest = Math.max(...b[1].map((e) => e.ts));
			return bLatest - aLatest; // newest first
		});
		const keep = new Set(ranked.slice(0, MAX_CHILDREN).map(([p]) => p));
		for (const p of [...byChild.keys()]) {
			if (!keep.has(p)) byChild.delete(p);
		}
		warnings.push(`sink exceeded MAX_CHILDREN=${MAX_CHILDREN}; dropped oldest children`);
	}

	// MAX_STEPS — per child, coalesce the `updated` stream when over budget.
	const result: BusEvent[] = [];
	let coalesced = false;
	for (const bucket of byChild.values()) {
		if (bucket.length <= MAX_STEPS) {
			result.push(...bucket);
			continue;
		}
		coalesced = true;
		const started = bucket.filter((e) => e.kind === "started");
		const completed = bucket.filter((e) => e.kind === "completed");
		const updated = bucket.filter((e) => e.kind === "updated");
		// Roll ordinary updates down to one latest entry, but retain the latest
		// progress and ledger snapshots independently. They are deliberately emitted
		// as separate bounded events because combining maximal valid payloads would
		// trigger serializeBounded's whole-fields truncation.
		const latest = updated.length > 0
			? updated.reduce((a, b) => (b.ts >= a.ts ? b : a))
			: undefined;
		const latestProgress = updated
			.filter((event) => event.fields && Object.prototype.hasOwnProperty.call(event.fields, TASK_PROGRESS_FIELD))
			.reduce<BusEvent | undefined>((latestEvent, event) => !latestEvent || event.ts >= latestEvent.ts ? event : latestEvent, undefined);
		const latestLedger = updated
			.filter((event) => event.fields && Object.prototype.hasOwnProperty.call(event.fields, TASK_LEDGER_FIELD))
			.reduce<BusEvent | undefined>((latestEvent, event) => !latestEvent || event.ts >= latestEvent.ts ? event : latestEvent, undefined);
		const rollingUpdated = [...new Set([latest, latestProgress, latestLedger].filter((event): event is BusEvent => event !== undefined))];
		result.push(...started, ...rollingUpdated, ...completed);
	}
	if (coalesced) {
		warnings.push(`a child exceeded MAX_STEPS=${MAX_STEPS}; coalesced updated stream`);
	}
	// Keep the file chronologically ordered.
	result.sort((a, b) => a.ts - b.ts);
	return { events: result, warnings };
}

/**
 * Resolve the frame a worker should EMIT bus events from (issue #9).
 *
 * Order matters:
 *   1. The LIVE ALS frame (`currentLineageFrame()`) — the in-process truth,
 *      carrying `idPath` so `lineageAncestorPath` yields the full root→self
 *      path a grandparent's REQ-BUS-2 prefix probe matches against. Inside
 *      any `runWithDepth` (every in-tree runner today) this always wins.
 *   2. The inherited env frame (`deserializeLineage(env)`) — the
 *      cross-process safety net. NOTE this is an IDENTITY read, not an
 *      authority read: even when the MAC does not verify under this
 *      process's rootSecret (the normal case across a process boundary) the
 *      returned frame's identity fields (rootRunId / runId / childIndex)
 *      are carried verbatim — only depth/cap are fail-closed-clamped, and
 *      the bus does not consume those for routing. Events therefore still
 *      land in the CORRECT root-run sink with a correct (leaf-only)
 *      lineagePath instead of silently not being emitted at all.
 *   3. `undefined` — genuine top-level process; bus emits no-op
 *      (best-effort, REQ-BUS-4).
 */
export function resolveBusFrame(
	env: Record<string, string | undefined> = process.env,
): DepthFrame | undefined {
	return currentLineageFrame() ?? deserializeLineage(env);
}

/**
 * Append a liveness event for `frame` to the root-run sink (REQ-BUS-1).
 *
 * BEST-EFFORT (REQ-BUS-4): ordinary failures — unresolvable agentDir,
 * unwritable dir, disk full — are swallowed behind a single throttled
 * diagnostics-log write. A contended non-blocking lock attempt falls back to
 * the append-only pending generation without an event-loop sleep.
 *
 * Bounds (REQ-BUS-6) are applied on every append: oversized payloads are
 * truncated, the per-child `updated` stream is coalesced past `MAX_STEPS`,
 * and the sink is capped to `MAX_CHILDREN` distinct children. The pure
 * bounds helpers RETURN their bookkeeping warning strings; this fn (the one
 * IO site that holds `agentDir`) performs the single diagnostics-log write
 * via `logBusDiagnostic` (REQ-BUSWARN-1/4).
 *
 * Each event also carries optional emitter identity stamps (`pidStartTicks`,
 * `pidBootId`, and local `pidNonce` where observable) so stale renewal can
 * prove exact PID generation continuity instead of relying on PID-only probes.
 */
let eventSequence = 0;
let eventGenerationSequence = 0;

function appendEventLine(file: string, line: string): void {
	fs.appendFileSync(file, `${line}\n`, { encoding: "utf8", mode: 0o600 });
	ensureOwnerOnlyFile(file);
}

function pendingHasPartialRecord(file: string): boolean {
	const pending = pendingEventFile(file);
	try {
		const bytes = fs.readFileSync(pending);
		return bytes.byteLength > 0 && bytes[bytes.byteLength - 1] !== 0x0a;
	} catch {
		return false;
	}
}

function appendFallbackEvent(file: string, line: string): void {
	const pending = pendingEventFile(file);
	const target = pendingHasPartialRecord(file)
		? `${pending}.rewrite-${process.pid}-${eventGenerationSequence++}`
		: pending;
	appendEventLine(target, line);
}

function compactSink(
	file: string,
	full: BusEvent,
): string[] {
	const pending = scanPendingSource(file);
	const main = scanSinkSource(file);
	const generations = eventGenerationFiles(file).map((generation) => scanSinkSource(generation));
	const merged = mergeSinkScans([main, pending, ...generations]);
	const candidates = merged.events.some((event) => eventIdentity(event) === eventIdentity(full))
		? merged.events
		: [...merged.events, full];
	const { events: bounded, warnings } = applyBounds(candidates);
	const malformedLines = merged.malformedLines;
	const lines: string[] = [];
	for (const event of bounded) {
		const serialized = serializeBounded(event);
		lines.push(serialized.line);
		if (serialized.warning) warnings.push(serialized.warning);
	}
	if (malformedLines.length > 0) {
		const quarantine = `${file}.malformed-${process.pid}-${eventGenerationSequence++}`;
		try {
			// A malformed producer line is not a liveness record, but it is
			// retained in a per-line quarantine instead of silently dropped or
			// taking the whole sink offline.
			replaceTextFile(quarantine, `${malformedLines.join("\n")}\n`);
			warnings.push(`quarantined ${malformedLines.length} malformed event line(s) at ${quarantine}`);
		} catch {
			// If the quarantine cannot be published, leave the raw lines in the
			// canonical sink so an IO failure cannot become data loss.
			lines.push(...malformedLines);
		}
	}
	// Publish the canonical generation first. The pending offset is advanced
	// only after this succeeds; if publication is interrupted, readers retain
	// the pending suffix and retry it on the next append/probe.
	replaceTextFile(file, `${lines.join("\n")}\n`);
	if (pending.consumedBytes > 0) {
		replaceTextFile(pendingOffsetFile(file), String(pending.consumedBytes));
	}
	return warnings;
}

export function appendBusEvent(
	args: { agentDir: string; frame: DepthFrame },
	event: {
		kind: BusEventKind;
		fields?: Record<string, unknown>;
		ts?: number;
		pid?: number;
	},
): void {
	try {
		const { agentDir, frame } = args;
		if (!agentDir || !frame?.rootRunId) return;
		const dir = resolveEventSinkDir(agentDir, frame.rootRunId);
		const file = resolveEventSinkFile(agentDir, frame.rootRunId);
		// Every append makes one non-blocking lock attempt. This is deliberately
		// not a retry: an uncontended writer appends under the same lock that
		// protects replacement, while a contended writer falls back to the
		// append-only pending generation without sleeping behind the lock holder.
		// That atomic admission decision closes the lock-observation/append race.
		ensureOwnerOnlyDirectory(dir);
		const pid = event.pid ?? process.pid;
		const capturedIdentity = captureProcessIdentity(pid);
		const full: BusEvent = {
			eventId: `${process.pid}-${Date.now()}-${eventSequence++}-${randomUUID()}`,
			ts: event.ts ?? Date.now(),
			lineagePath: lineagePath(frame),
			ancestorPath: lineageAncestorPath(frame),
			kind: event.kind,
			pid,
			...(capturedIdentity ? {
				pidStartTicks: capturedIdentity.startTicks,
				pidBootId: capturedIdentity.bootId,
			} : {}),
			...(pid === process.pid ? { pidNonce: getProcessNonce() } : {}),
			depth: frame.depth,
			...(event.fields ? { fields: event.fields } : {}),
		};
		const serialized = serializeBounded(full);
		const warnings: string[] = serialized.warning ? [serialized.warning] : [];
		const result = tryWithStateFileLock(dir, () => {
			const scan = readSinkScan(file);
			const candidate = [...scan.events, full];
			const bounded = applyBounds(candidate);
			const needsRewrite = scan.malformedLines.length > 0 || bounded.events.length !== candidate.length;
			if (needsRewrite) {
				// Make the triggering event durable before the fallible canonical
				// replacement. Its eventId lets the successful retry merge this copy
				// without duplicating it in the canonical generation.
				appendFallbackEvent(file, serialized.line);
				return compactSink(file, full);
			}
			appendEventLine(file, serialized.line);
			return [];
		});
		if (result.acquired) {
			warnings.push(...result.value);
		} else {
			// Retain the durable fallback before mirroring to the canonical path.
			// Existing readers inspect events.ndjson directly, so the mirror keeps
			// that compatibility surface populated during a held lock; the pending
			// generation is the recoverable source if a concurrent rewrite replaces
			// the canonical inode after this append.
			appendFallbackEvent(file, serialized.line);
			appendEventLine(file, serialized.line);
		}
		try {
			updateBusTerminalSummary(agentDir, frame.rootRunId, full);
		} catch (err) {
			logBusDiagnostic(
				agentDir,
				`terminal summary update failed (best-effort): ${(err as Error)?.message ?? err}`,
			);
		}
		for (const warning of warnings) logBusDiagnostic(agentDir, warning);
	} catch (err) {
		if (err instanceof StateLockTimeoutError) throw err;
		logBusDiagnostic(
			args.agentDir,
			`append failed (best-effort, swallowed): ${(err as Error)?.message ?? err}`,
		);
	}
}

/**
 * Best-effort liveness check on a pid: true iff the process is alive.
 *
 * Canonical home for the signal-0 liveness probe shared across the
 * detached-orchestrate substrate. `detached-spawn.ts` (the crash reaper) and
 * other detached-owner checks import this helper instead of carrying duplicate
 * probe logic.
 */
export function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	if (pid === process.pid) return true;
	try {
		// Signal 0 probes existence without delivering a signal.
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means the process exists but we can't signal it → alive.
		return (err as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

/** Read the bounded event set for a detached root after a child reaches terminal. */
export function readBusEvents(agentDir: string, rootRunId: string): readonly BusEvent[] {
	try {
		if (!agentDir || !rootRunId) return [];
		return readSinkScan(resolveEventSinkFile(agentDir, rootRunId)).events;
	} catch {
		return [];
	}
}

/**
 * Did ANY descendant of `ancestorPath` emit an event within `windowMs`
 * (REQ-BUS-2)? This is the liveness signal the heartbeat consults before
 * counting silence: a busy grandchild keeps a quiet parent alive.
 *
 * Descendant test (TRUE ancestry, not depth): same root sink, and the
 * emitter's `ancestorPath` is STRICTLY PREFIXED by the probing ancestor's
 * own `ancestorPath` (i.e. `event.ancestorPath` starts with
 * `ancestorPath + "/"`). Prefix membership is exactly the descendant
 * relation because the id-path is accumulated additively down the tree
 * (`runWithDepth`), so a true descendant's path begins with its ancestor's
 * path and a same-root COUSIN's does not — even when the cousin sits at a
 * GREATER depth. A bare depth comparison (`event.depth > ancestorDepth`)
 * would wrongly treat that busy cousin as a descendant and let it mask a
 * genuinely-stuck immediate run, blocking its legitimate wind-down forever
 * — which is NOT suppress-only safe. Prefix matching closes that.
 *
 * For a detached emitter (a different pid from the verifier), a stale last
 * event counts as active ONLY when the exact emitting process generation is
 * proven live (`verifyProcessIdentity(...) === "match"`). A bare pid probe, or
 * any `mismatch` / `absent` / `unproven` verdict, must not renew liveness.
 * Legacy records without birth/boot identity therefore fail closed to
 * `unproven` and do not renew stale activity.
 *
 * Best-effort: any read failure returns `false` (no false liveness).
 */
export function readDescendantActivity(args: {
	agentDir: string;
	rootRunId: string;
	ancestorPath: string;
	/** @deprecated retained for caller compatibility; ancestry is path-prefix, not depth. */
	ancestorDepth?: number;
	windowMs: number;
	now?: number;
	/** @deprecated retained for caller compatibility; stale renewal now requires identity proof. */
	pidAliveFn?: (pid: number) => boolean;
	/** Test seam: injected process-identity IO for deterministic verdict checks. */
	processIdentityDependencies?: Partial<ProcessIdentityDependencies>;
}): boolean {
	try {
		const { agentDir, rootRunId, ancestorPath, windowMs } = args;
		if (!agentDir || !rootRunId) return false;
		const file = resolveEventSinkFile(agentDir, rootRunId);
		const scan = readSinkScan(file);
		if (scan.malformedLines.length > 0) {
			logBusDiagnostic(
				agentDir,
				`ignored ${scan.malformedLines.length} malformed event line(s); raw lines remain in the sink`,
			);
		}
		const events = scan.events;
		const now = args.now ?? Date.now();
		const cutoff = now - windowMs;
		const prefix = `${ancestorPath}/`;
		for (const ev of events) {
			// TRUE descendant: the emitter's full ancestor path is strictly
			// prefixed by the ancestor's own path. Skip the ancestor itself, any
			// non-descendant (cousin / sibling / unrelated), and events lacking an
			// ancestorPath (pre-field sink lines — cannot prove descendancy).
			if (typeof ev.ancestorPath !== "string") continue;
			if (!ev.ancestorPath.startsWith(prefix)) continue;
			if (ev.kind === "completed") continue; // a finished descendant is not "still working"
			if (ev.ts >= cutoff) return true; // recent in-process or detached event
			// Stale event: only a PROVEN matching emitter generation may renew
			// liveness. Bare pid checks are insufficient because a reused pid from an
			// unrelated process can still answer signal 0.
			if (typeof ev.pid !== "number" || ev.pid === process.pid) continue;
			const verdict = verifyProcessIdentity(
				{
					pid: ev.pid,
					startTicks: ev.pidStartTicks,
					bootId: ev.pidBootId,
				},
				args.processIdentityDependencies,
			);
			if (verdict === "match") return true;
		}
		return false;
	} catch {
		return false;
	}
}

/**
 * Delete event-sink dirs older than `maxAgeMs` (default 24 h). Mirrors
 * `sweepOldChainDirs` in `src/output-file.ts`: best-effort, opportunistic
 * (call on session_start / new root run). [decision: sink-cleanup-age-sweep]
 *
 * Returns the number of dirs removed.
 */
export function sweepOldEventSinks(args: {
	agentDir: string;
	maxAgeMs?: number;
	now?: number;
}): number {
	const busRoot = path.join(args.agentDir, "extensions", "pi-delegate", "event-bus");
	if (!fs.existsSync(busRoot)) return 0;
	const maxAgeMs = args.maxAgeMs ?? 24 * 60 * 60 * 1000;
	const cutoff = (args.now ?? Date.now()) - maxAgeMs;
	let removed = 0;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(busRoot, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const full = path.join(busRoot, entry.name);
		try {
			const stat = fs.statSync(full);
			if (stat.mtimeMs < cutoff) {
				fs.rmSync(full, { recursive: true, force: true });
				removed++;
			}
		} catch {
			/* swallow; best-effort */
		}
	}
	return removed;
}
