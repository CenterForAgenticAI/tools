import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { addressKey, formatNodeAddress } from "../plan/index.js";
import {
	decodeVerificationCacheUpdate,
	type ObservedVerificationCacheUpdate,
	type TreeIdentity,
} from "../verify/index.js";
import type { NodeAddress, NodeContractAssembly } from "../plan/index.js";
import type { Evidence } from "../schema/workspec.js";
import type {
	ObservationReport,
	ObservedReviewRecord,
	StatusCacheDecode,
	StatusCacheDispatchEntry,
	StatusCacheDispatchInputDigest,
	StatusCacheDispatchSection,
	StatusCacheDispatchSlot,
	StatusCacheDispatchWriteResult,
	StatusCacheV1,
	StatusFinding,
	StatusGraph,
	StatusCacheVerificationEntry,
} from "./types.js";

export const STATUS_CACHE_VERSION = 1 as const;
export const STATUS_CACHE_DISPATCH_WRITE_MAX_ATTEMPTS = 8 as const;
export const STATUS_CACHE_READBACK_RESIDUAL = "readback-may-precede-later-overwrite" as const;

const DISPATCH_CACHE_READBACK_SETTLE_MS = 50;

const CACHE_DIRECTORY = path.join(".work", ".cache");

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown): value is string {
	return typeof value === "string";
}

function validAddress(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.length > 0 && value.every((segment) => typeof segment === "string" && segment.length > 0);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function validTimestamp(value: unknown): value is string {
	return string(value) && Number.isFinite(Date.parse(value));
}

function validTree(value: unknown): value is TreeIdentity {
	if (!record(value) || value.kind !== "git" || !string(value.worktreePath) || !value.worktreePath.startsWith("/") || !string(value.resolvedCommit) || !/^[0-9a-f]{40}$/.test(value.resolvedCommit)) return false;
	return exactKeys(value, ["kind", "worktreePath", "resolvedCommit"]);
}

function sameTree(left: TreeIdentity, right: TreeIdentity): boolean {
	if (left.kind !== right.kind) return false;
	switch (left.kind) {
		case "git":
			return right.kind === "git" && left.worktreePath === right.worktreePath && left.resolvedCommit === right.resolvedCommit;
	}
}

export function sameTreeIdentity(left: TreeIdentity, right: TreeIdentity): boolean {
	return sameTree(left, right);
}

function safeRelativePath(worktreePath: string, specPath: string): string {
	const relative = path.relative(worktreePath, specPath);
	return relative.split(path.sep).join("/");
}

/** Resolve a contained deterministic cache name without touching the filesystem. */
export function statusCachePath(worktreePath: string, specPath: string): string {
	const relative = safeRelativePath(worktreePath, specPath);
	const digest = createHash("sha256").update(relative, "utf8").digest("hex").slice(0, 24);
	return path.resolve(worktreePath, CACHE_DIRECTORY, `${digest}.json`);
}

export function emptyStatusCache(specPath: string): StatusCacheV1 {
	return {
		kind: "pi-work-status-cache",
		version: STATUS_CACHE_VERSION,
		specPath,
		verification: {},
		review: {},
		dispatch: {},
	};
}

function malformed(pathName: string, message: string, address?: readonly string[]): StatusFinding {
	return { code: "malformed-cache-entry", ...(address === undefined ? {} : { address }), message: `${pathName}: ${message}` };
}

function decodeReview(value: unknown): ObservedReviewRecord | undefined {
	if (!record(value) || !exactKeys(value, ["address", "verdict", "tree", "source", "recordedAt"]) || !validAddress(value.address) || (value.verdict !== "approved" && value.verdict !== "rejected") || !validTree(value.tree) || !string(value.source) || value.source.length === 0 || !validTimestamp(value.recordedAt)) return undefined;
	return {
		address: [...value.address],
		verdict: value.verdict,
		tree: value.tree,
		source: value.source,
		recordedAt: value.recordedAt,
	};
}

function optionalString(value: Record<string, unknown>, key: string): boolean {
	return value[key] === undefined || string(value[key]) && (value[key] as string).length > 0;
}

function optionalBoolean(value: Record<string, unknown>, key: string): boolean {
	return value[key] === undefined || typeof value[key] === "boolean";
}

function validSha256(value: unknown): value is string {
	return string(value) && /^[0-9a-f]{64}$/.test(value);
}

function decodeDispatchDigest(value: unknown): StatusCacheDispatchInputDigest | undefined {
	if (!record(value) || !exactKeys(value, ["kind", "name", "algorithm", "digest"]) || (value.kind !== "task" && value.kind !== "read" && value.kind !== "checklist" && value.kind !== "focus") || !string(value.name) || value.name.length === 0 || value.algorithm !== "sha256" || !validSha256(value.digest)) return undefined;
	return { kind: value.kind, name: value.name, algorithm: "sha256", digest: value.digest };
}

function decodeDispatchSlot(value: unknown): StatusCacheDispatchSlot | undefined {
	if (!record(value)) return undefined;
	const allowed = new Set(["agent", "workerCwd", "branch", "maxRounds", "cloneMode", "collapseMode", "confineWrites", "readOnly", "requestedModel", "resolvedModel", "skills", "inputDigests"]);
	if (Object.keys(value).some((key) => !allowed.has(key)) || !string(value.agent) || value.agent.length === 0 || !Number.isInteger(value.maxRounds) || (value.maxRounds as number) < 1 || !optionalString(value, "workerCwd") || !optionalString(value, "branch") || !optionalString(value, "cloneMode") || !optionalString(value, "collapseMode") || !optionalBoolean(value, "confineWrites") || !optionalBoolean(value, "readOnly") || !optionalString(value, "requestedModel") || !optionalString(value, "resolvedModel") || !Array.isArray(value.inputDigests)) return undefined;
	if (value.workerCwd !== undefined && (!path.isAbsolute(value.workerCwd as string) || path.normalize(value.workerCwd as string) !== value.workerCwd)) return undefined;
	if (value.skills !== undefined && (!Array.isArray(value.skills) || value.skills.length === 0 || !value.skills.every((skill) => string(skill) && skill.length > 0))) return undefined;
	const inputDigests = value.inputDigests.map(decodeDispatchDigest);
	if (inputDigests.some((digest) => digest === undefined)) return undefined;
	return {
		agent: value.agent,
		...(value.workerCwd === undefined ? {} : { workerCwd: value.workerCwd as string }),
		...(value.branch === undefined ? {} : { branch: value.branch as string }),
		maxRounds: value.maxRounds as number,
		...(value.cloneMode === undefined ? {} : { cloneMode: value.cloneMode as string }),
		...(value.collapseMode === undefined ? {} : { collapseMode: value.collapseMode as string }),
		...(value.confineWrites === undefined ? {} : { confineWrites: value.confineWrites as boolean }),
		...(value.readOnly === undefined ? {} : { readOnly: value.readOnly as boolean }),
		...(value.requestedModel === undefined ? {} : { requestedModel: value.requestedModel as string }),
		...(value.resolvedModel === undefined ? {} : { resolvedModel: value.resolvedModel as string }),
		...(value.skills === undefined ? {} : { skills: [...value.skills as string[]] }),
		inputDigests: inputDigests as StatusCacheDispatchInputDigest[],
	};
}

function decodeDispatchEntry(value: unknown): StatusCacheDispatchEntry | undefined {
	const keys = ["runId", "forkName", "nodeId", "address", "createdAt", "worktreePath", "headCommit", "branch", "briefPath", "briefSha256", "slot", "receiptPath", "resultPath"];
	if (!record(value) || !exactKeys(value, keys) || !string(value.runId) || value.runId.length === 0 || !string(value.forkName) || value.forkName.length === 0 || !string(value.nodeId) || value.nodeId.length === 0 || !validAddress(value.address) || !validTimestamp(value.createdAt) || !string(value.worktreePath) || !path.isAbsolute(value.worktreePath) || path.normalize(value.worktreePath) !== value.worktreePath || !string(value.headCommit) || !/^[0-9a-f]{40}$/.test(value.headCommit) || !string(value.branch) || value.branch.length === 0 || !string(value.briefPath) || !path.isAbsolute(value.briefPath) || path.normalize(value.briefPath) !== value.briefPath || !validSha256(value.briefSha256) || !string(value.receiptPath) || !path.isAbsolute(value.receiptPath) || path.normalize(value.receiptPath) !== value.receiptPath || !string(value.resultPath) || !path.isAbsolute(value.resultPath) || path.normalize(value.resultPath) !== value.resultPath) return undefined;
	const slot = decodeDispatchSlot(value.slot);
	if (!slot) return undefined;
	return {
		runId: value.runId,
		forkName: value.forkName,
		nodeId: value.nodeId,
		address: [...value.address],
		createdAt: value.createdAt,
		worktreePath: value.worktreePath,
		headCommit: value.headCommit,
		branch: value.branch,
		briefPath: value.briefPath,
		briefSha256: value.briefSha256,
		slot,
		receiptPath: value.receiptPath,
		resultPath: value.resultPath,
	};
}

function decodeDispatch(value: unknown, sourcePath: string): { dispatch: StatusCacheDispatchSection; findings: StatusFinding[] } {
	if (!record(value)) return { dispatch: {}, findings: [malformed(sourcePath, "dispatch section must be a run-id-keyed object")] };
	const dispatch: Record<string, StatusCacheDispatchEntry> = {};
	const findings: StatusFinding[] = [];
	for (const [key, rawEntry] of Object.entries(value)) {
		const entry = decodeDispatchEntry(rawEntry);
		if (!entry) {
			findings.push(malformed(`${sourcePath}[${key}]`, "dispatch entry is malformed"));
			continue;
		}
		if (key !== entry.runId) {
			findings.push(malformed(`${sourcePath}[${key}]`, `key must equal runId ${entry.runId}`, entry.address));
			continue;
		}
		dispatch[key] = entry;
	}
	return { dispatch, findings };
}

function decodeVerificationEntry(value: unknown): StatusCacheVerificationEntry | undefined {
	if (!record(value) || !exactKeys(value, ["address", "update"]) || !validAddress(value.address)) return undefined;
	const update = decodeVerificationCacheUpdate(value.update);
	if (!update) return undefined;
	return { address: [...value.address], update };
}

/** Strictly decode JSON data. No decoded object is a trusted verification result. */
export function decodeStatusCache(value: unknown, sourcePath = "<cache>"): StatusCacheDecode {
	if (!record(value)) return { findings: [{ code: "malformed-cache", path: sourcePath, message: "cache root must be an object" }] };
	if (value.version !== STATUS_CACHE_VERSION) {
		return { findings: [{ code: "unsupported-cache-version", path: sourcePath, version: value.version, message: `unsupported status cache version ${String(value.version)}` }] };
	}
	if (!exactKeys(value, ["kind", "version", "specPath", "verification", "review", "dispatch"]) || value.kind !== "pi-work-status-cache" || !string(value.specPath) || value.specPath.length === 0 || !record(value.verification) || !record(value.review)) {
		return { findings: [{ code: "malformed-cache", path: sourcePath, message: "cache root has an invalid or unknown field" }] };
	}
	const findings: StatusFinding[] = [];
	const verification: Record<string, StatusCacheVerificationEntry> = {};
	const addresses = new Set<string>();
	for (const [key, entry] of Object.entries(value.verification)) {
		const decoded = decodeVerificationEntry(entry);
		if (!decoded) {
			findings.push(malformed(`${sourcePath}.verification[${key}]`, "verification entry is malformed"));
			continue;
		}
		const canonical = addressKey(decoded.address);
		if (key !== canonical) {
			findings.push(malformed(`${sourcePath}.verification[${key}]`, `key must be ${canonical}`, decoded.address));
			continue;
		}
		if (addresses.has(canonical)) {
			findings.push({ code: "cache-duplicate-address", address: decoded.address, message: `verification cache contains duplicate address ${formatNodeAddress(decoded.address)}` });
			continue;
		}
		addresses.add(canonical);
		verification[canonical] = decoded;
	}
	const review: Record<string, ObservedReviewRecord> = {};
	const reviewAddresses = new Set<string>();
	for (const [key, entry] of Object.entries(value.review)) {
		const decoded = decodeReview(entry);
		if (!decoded) {
			findings.push(malformed(`${sourcePath}.review[${key}]`, "review entry is malformed"));
			continue;
		}
		const canonical = addressKey(decoded.address);
		if (key !== canonical) {
			findings.push(malformed(`${sourcePath}.review[${key}]`, `key must be ${canonical}`, decoded.address));
			continue;
		}
		if (reviewAddresses.has(canonical)) {
			findings.push({ code: "cache-duplicate-address", address: decoded.address, message: `review cache contains duplicate address ${formatNodeAddress(decoded.address)}` });
			continue;
		}
		reviewAddresses.add(canonical);
		review[canonical] = decoded;
	}
	const decodedDispatch = decodeDispatch(value.dispatch, `${sourcePath}.dispatch`);
	findings.push(...decodedDispatch.findings);
	if (findings.length > 0 && Object.keys(verification).length === 0 && Object.keys(review).length === 0 && Object.keys(decodedDispatch.dispatch).length === 0) return { findings };
	return {
		cache: {
			kind: "pi-work-status-cache",
			version: 1,
			specPath: value.specPath,
			verification,
			review,
			dispatch: decodedDispatch.dispatch,
		},
		findings,
	};
}

export interface ReadStatusCacheResult {
	readonly cache?: StatusCacheV1;
	readonly findings: readonly StatusFinding[];
}

type CacheRecordSection = "verification" | "review" | "dispatch";

/** Find repeated address keys before JSON.parse collapses them. */
function duplicateSectionKeys(source: string): ReadonlyMap<CacheRecordSection, readonly string[]> {
	const duplicates = new Map<CacheRecordSection, string[]>();
	let cursor = 0;

	const skipWhitespace = (): void => {
		while (cursor < source.length && /\s/.test(source[cursor] ?? "")) cursor += 1;
	};

	const parseString = (): string => {
		const start = cursor;
		if (source[cursor] !== '"') throw new Error("expected JSON string");
		cursor += 1;
		while (cursor < source.length) {
			const character = source[cursor];
			if (character === "\\") {
				cursor += 2;
				continue;
			}
			if (character === '"') {
				cursor += 1;
				return JSON.parse(source.slice(start, cursor)) as string;
			}
			cursor += 1;
		}
		throw new Error("unterminated JSON string");
	};

	const parseValue = (pathParts: readonly string[]): void => {
		skipWhitespace();
		const character = source[cursor];
		if (character === "{") {
			parseObject(pathParts);
			return;
		}
		if (character === "[") {
			parseArray(pathParts);
			return;
		}
		if (character === '"') {
			parseString();
			return;
		}
		while (cursor < source.length && !/[\s,}\]]/.test(source[cursor] ?? "")) cursor += 1;
	};

	const parseArray = (pathParts: readonly string[]): void => {
		if (source[cursor] !== "[") throw new Error("expected JSON array");
		cursor += 1;
		skipWhitespace();
		if (source[cursor] === "]") {
			cursor += 1;
			return;
		}
		while (cursor < source.length) {
			parseValue(pathParts);
			skipWhitespace();
			if (source[cursor] === "]") {
				cursor += 1;
				return;
			}
			if (source[cursor] !== ",") throw new Error("expected JSON array separator");
			cursor += 1;
		}
		throw new Error("unterminated JSON array");
	};

	const parseObject = (pathParts: readonly string[]): void => {
		if (source[cursor] !== "{") throw new Error("expected JSON object");
		cursor += 1;
		const keys = new Set<string>();
		skipWhitespace();
		if (source[cursor] === "}") {
			cursor += 1;
			return;
		}
		while (cursor < source.length) {
			const key = parseString();
			if ((pathParts[0] === "verification" || pathParts[0] === "review" || pathParts[0] === "dispatch") && pathParts.length === 1 && keys.has(key)) {
				const section = pathParts[0];
				const sectionDuplicates = duplicates.get(section) ?? [];
				if (!sectionDuplicates.includes(key)) sectionDuplicates.push(key);
				duplicates.set(section, sectionDuplicates);
			}
			keys.add(key);
			skipWhitespace();
			if (source[cursor] !== ":") throw new Error("expected JSON object separator");
			cursor += 1;
			parseValue([...pathParts, key]);
			skipWhitespace();
			if (source[cursor] === "}") {
				cursor += 1;
				return;
			}
			if (source[cursor] !== ",") throw new Error("expected JSON object separator");
			cursor += 1;
			skipWhitespace();
		}
		throw new Error("unterminated JSON object");
	};

	try {
		parseValue([]);
		skipWhitespace();
		if (cursor !== source.length) return new Map();
		return duplicates;
	} catch {
		return new Map();
	}
}

function duplicateAddress(section: CacheRecordSection, key: string, value: unknown): NodeAddress | undefined {
	try {
		const parsed = JSON.parse(key) as unknown;
		if (validAddress(parsed)) return [...parsed];
	} catch {
		// The cache decoder will report malformed non-address keys separately.
	}
	if (!record(value)) return undefined;
	const sectionValue = value[section];
	if (!record(sectionValue)) return undefined;
	const entry = sectionValue[key];
	return record(entry) && validAddress(entry.address) ? [...entry.address] : undefined;
}

function withoutDuplicateEntries(value: unknown, duplicates: ReadonlyMap<CacheRecordSection, readonly string[]>): unknown {
	if (!record(value)) return value;
	const result: Record<string, unknown> = { ...value };
	for (const section of ["verification", "review", "dispatch"] as const) {
		const entries = value[section];
		if (!record(entries)) continue;
		const filtered = { ...entries };
		for (const key of duplicates.get(section) ?? []) delete filtered[key];
		result[section] = filtered;
	}
	return result;
}

function decodeStatusCacheSource(source: string, cachePath: string): ReadStatusCacheResult {
	let value: unknown;
	try {
		value = JSON.parse(source) as unknown;
	} catch (error) {
		return { findings: [{ code: "cache-parse-error", path: cachePath, message: error instanceof Error ? error.message : String(error) }] };
	}
	const duplicates = duplicateSectionKeys(source);
	const duplicateFindings: StatusFinding[] = [];
	for (const section of ["verification", "review", "dispatch"] as const) {
		for (const key of duplicates.get(section) ?? []) {
			if (section === "dispatch") duplicateFindings.push({ code: "cache-duplicate-run-id", runId: key, message: `dispatch cache contains duplicate runId ${key}` });
			else {
				const address = duplicateAddress(section, key, value);
				if (address !== undefined) duplicateFindings.push({ code: "cache-duplicate-address", address, message: `${section} cache contains duplicate address ${formatNodeAddress(address)}` });
			}
		}
	}
	const decoded = decodeStatusCache(withoutDuplicateEntries(value, duplicates), cachePath);
	return { ...(decoded.cache === undefined ? {} : { cache: decoded.cache }), findings: [...duplicateFindings, ...decoded.findings] };
}

export async function readStatusCache(cachePath: string): Promise<ReadStatusCacheResult> {
	let source: string;
	try {
		source = await readFile(cachePath, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { findings: [] };
		return { findings: [{ code: "cache-read-error", path: cachePath, message: error instanceof Error ? error.message : String(error) }] };
	}
	return decodeStatusCacheSource(source, cachePath);
}

function canonicalSpecPath(root: string, value: string): string | undefined {
	if (value.startsWith("/")) return value;
	const resolved = path.resolve(root, value.replace(/^@/, "").replace(/^[/\\]+/, ""));
	const relative = path.relative(root, resolved);
	if (relative.length === 0 || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
	return resolved;
}

interface DispatchCacheSnapshot {
	readonly cache: StatusCacheV1;
}

async function readDispatchCacheSnapshot(cachePath: string, specPath: string, worktreePath: string): Promise<DispatchCacheSnapshot | StatusCacheDispatchWriteResult> {
	let source: string;
	try {
		source = await readFile(cachePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { cache: emptyStatusCache(specPath) };
		return { status: "failed", path: cachePath, attempts: 0, reason: "cache-read-error", message: error instanceof Error ? error.message : String(error) };
	}
	const decoded = decodeStatusCacheSource(source, cachePath);
	if (!decoded.cache || decoded.findings.length > 0) {
		return { status: "failed", path: cachePath, attempts: 0, reason: "malformed-cache", message: decoded.findings.map((finding) => finding.message).join("; ") || "cache did not decode" };
	}
	const decodedSpecPath = canonicalSpecPath(worktreePath, decoded.cache.specPath);
	if (decodedSpecPath !== specPath) {
		return { status: "failed", path: cachePath, attempts: 0, reason: "cache-source-mismatch", message: `cache belongs to ${decoded.cache.specPath}, not ${specPath}` };
	}
	return { cache: decoded.cache };
}

function sameDispatchEntry(left: StatusCacheDispatchEntry, right: StatusCacheDispatchEntry): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Merge one dispatch hint into the sole derived cache.
 *
 * Every successful rename is read back before success is reported. A later
 * writer can still overwrite an entry after that observation; this is the
 * bounded read-back mechanism's named residual.
 */
export async function writeDispatchCacheEntry(cachePath: string, specPath: string, worktreePath: string, entry: StatusCacheDispatchEntry): Promise<StatusCacheDispatchWriteResult> {
	try {
		await mkdir(path.dirname(cachePath), { recursive: true });
	} catch (error) {
		return { status: "failed", path: cachePath, attempts: 0, reason: "cache-write-error", message: error instanceof Error ? error.message : String(error) };
	}
	for (let attempt = 1; attempt <= STATUS_CACHE_DISPATCH_WRITE_MAX_ATTEMPTS; attempt += 1) {
		const snapshot = await readDispatchCacheSnapshot(cachePath, specPath, worktreePath);
		if ("status" in snapshot) return { ...snapshot, attempts: attempt };
		const existing = snapshot.cache.dispatch[entry.runId];
		if (existing && !sameDispatchEntry(existing, entry)) {
			return { status: "failed", path: cachePath, attempts: attempt, reason: "run-id-conflict", message: `cache already contains different data for runId ${entry.runId}` };
		}
		if (existing) return { status: "written", path: cachePath, attempts: attempt, residualRace: STATUS_CACHE_READBACK_RESIDUAL };
		const merged: StatusCacheV1 = { ...snapshot.cache, dispatch: { ...snapshot.cache.dispatch, [entry.runId]: entry } };
		const temporary = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			await rename(temporary, cachePath);
			// Let already-issued overlapping file operations settle before read-back.
			// This delay belongs only to the bounded cache-write attempt; it never
			// waits on, polls, or re-attempts the dispatch that produced the entry.
			await new Promise<void>((resolve) => setTimeout(resolve, DISPATCH_CACHE_READBACK_SETTLE_MS));
			const readBack = await readDispatchCacheSnapshot(cachePath, specPath, worktreePath);
			if ("status" in readBack) return { ...readBack, attempts: attempt };
			const observed = readBack.cache.dispatch[entry.runId];
			if (observed && sameDispatchEntry(observed, entry)) {
				return { status: "written", path: cachePath, attempts: attempt, residualRace: STATUS_CACHE_READBACK_RESIDUAL };
			}
			if (observed) {
				return { status: "failed", path: cachePath, attempts: attempt, reason: "run-id-conflict", message: `cache contains different data for runId ${entry.runId} after write` };
			}
		} catch (error) {
			await unlink(temporary).catch(() => undefined);
			return { status: "failed", path: cachePath, attempts: attempt, reason: "cache-write-error", message: error instanceof Error ? error.message : String(error) };
		}
	}
	return {
		status: "contended",
		path: cachePath,
		attempts: STATUS_CACHE_DISPATCH_WRITE_MAX_ATTEMPTS,
		residualRace: STATUS_CACHE_READBACK_RESIDUAL,
		message: `entry was absent after all ${STATUS_CACHE_DISPATCH_WRITE_MAX_ATTEMPTS} bounded write-and-read-back attempts`,
	};
}

function sameContract(assembly: NodeContractAssembly, update: ObservedVerificationCacheUpdate): boolean {
	const expected = assembly.node.acceptance ?? [];
	const actual = update.record.criteria;
	if (expected.length !== actual.length) return false;
	for (let index = 0; index < expected.length; index += 1) {
		const criterion = expected[index];
		const observed = actual[index];
		if (!criterion || !observed || criterion.id !== observed.criterion.id || criterion.statement !== observed.criterion.statement) return false;
		const observedEvidence = observed.outcome === "failed" ? observed.attempt.evidence : observed.proof.kind === "command-proof" ? { kind: "command" as const, run: observed.proof.authoredCommand, expect: observed.proof.expectation, ...(observed.proof.timeout_ms === undefined ? {} : { timeout_ms: observed.proof.timeout_ms }) } : observed.proof.kind === "agent-proof" ? { kind: "agent" as const, agent: observed.proof.agent, inputs: observed.proof.inputs.map((input) => input.path), rubric: observed.proof.rubric } : { kind: "user" as const, prompt: observed.proof.prompt };
		if (criterion.evidence.kind === "command" && observedEvidence.kind === "command") {
			if (criterion.evidence.run !== observedEvidence.run || JSON.stringify(criterion.evidence.expect) !== JSON.stringify(observedEvidence.expect) || criterion.evidence.timeout_ms !== observedEvidence.timeout_ms) return false;
		} else if (JSON.stringify(criterion.evidence as Evidence) !== JSON.stringify(observedEvidence)) return false;
	}
	const expectedChecklist = "checklist" in assembly.node && Array.isArray(assembly.node.checklist) ? assembly.node.checklist : [];
	const actualChecklist = update.record.checklist.items;
	if (expectedChecklist.length !== actualChecklist.length) return false;
	return expectedChecklist.every((item, index) => item === actualChecklist[index]?.item && index === actualChecklist[index]?.index);
}

export interface ClassifiedCache {
	readonly observations: ReadonlyMap<string, ObservationReport>;
	readonly review: ReadonlyMap<string, "observed-approval-not-authoritative" | "observed-rejection-not-authoritative">;
	readonly dispatch: StatusCacheDispatchSection;
	readonly findings: readonly StatusFinding[];
}

/** Bind decoded observations to the current source, qualified address, and exact tree. */
export function classifyStatusCache(cache: StatusCacheV1 | undefined, graph: StatusGraph, tree: TreeIdentity, specPath: string, worktreePath: string): ClassifiedCache {
	const observations = new Map<string, ObservationReport>();
	const review = new Map<string, "observed-approval-not-authoritative" | "observed-rejection-not-authoritative">();
	const dispatch: Record<string, StatusCacheDispatchEntry> = {};
	const findings: StatusFinding[] = [];
	if (!cache) return { observations, review, dispatch, findings };
	const canonicalCacheSpec = canonicalSpecPath(worktreePath, cache.specPath) ?? cache.specPath;
	if (canonicalCacheSpec !== specPath) {
		findings.push({ code: "cache-source-mismatch", expected: specPath, actual: cache.specPath, message: `cache belongs to ${cache.specPath}, not ${specPath}` });
		return { observations, review, dispatch, findings };
	}
	for (const [key, entry] of Object.entries(cache.verification)) {
		const assembly = graph.byAddress.get(key);
		if (!assembly) {
			findings.push({ code: "cache-unknown-address", address: entry.address, message: `cache observation names unknown address ${formatNodeAddress(entry.address)}` });
			continue;
		}
		const sameIdAddresses = graph.assemblies.filter((candidate) => candidate.node.id === entry.update.nodeId).map((candidate) => candidate.address);
		if (sameIdAddresses.length > 1) {
			findings.push({ code: "ambiguous-node-id", nodeId: entry.update.nodeId, addresses: sameIdAddresses, message: `cache observation for ${entry.update.nodeId} cannot be attributed because it occurs at ${sameIdAddresses.map(formatNodeAddress).join(", ")}` });
			continue;
		}
		if (entry.update.nodeId !== assembly.node.id) {
			findings.push({ code: "cache-address-mismatch", address: entry.address, nodeId: entry.update.nodeId, message: `cache node ${entry.update.nodeId} cannot be used for ${formatNodeAddress(entry.address)}` });
			continue;
		}
		const updateSpec = canonicalSpecPath(worktreePath, entry.update.specPath);
		if (updateSpec !== specPath) {
			findings.push({ code: "cache-source-mismatch", expected: specPath, actual: entry.update.specPath, message: `cache verification update belongs to ${entry.update.specPath}, not ${specPath}` });
			continue;
		}
		if (!sameTree(entry.update.tree, tree)) {
			observations.set(key, { state: "stale-observation", update: entry.update });
			findings.push({ code: "stale-cache-observation", address: entry.address, message: `observation for ${formatNodeAddress(entry.address)} is not for the exact current TreeIdentity` });
			continue;
		}
		if (!sameContract(assembly, entry.update)) {
			observations.set(key, { state: "conflicting-observation", update: entry.update });
			findings.push({ code: "cache-source-conflict", address: entry.address, message: `cached criterion or checklist data conflicts with the current workspec for ${formatNodeAddress(entry.address)}` });
			continue;
		}
		observations.set(key, entry.update.record.outcome === "passed" ? { state: "observed-green-not-verified-this-session", update: entry.update } : { state: "observed-failure-not-verified-this-session", update: entry.update });
	}
	for (const [key, entry] of Object.entries(cache.review)) {
		if (!graph.byAddress.has(key)) {
			findings.push({ code: "cache-unknown-address", address: entry.address, message: `review observation names unknown address ${formatNodeAddress(entry.address)}` });
			continue;
		}
		if (!sameTree(entry.tree, tree)) continue;
		review.set(key, entry.verdict === "approved" ? "observed-approval-not-authoritative" : "observed-rejection-not-authoritative");
	}
	for (const [runId, entry] of Object.entries(cache.dispatch)) {
		const assembly = graph.byAddress.get(addressKey(entry.address));
		if (!assembly) {
			findings.push({ code: "cache-unknown-address", address: entry.address, message: `dispatch hint ${runId} names unknown address ${formatNodeAddress(entry.address)}` });
			continue;
		}
		if (assembly.node.id !== entry.nodeId) {
			findings.push({ code: "cache-dispatch-node-mismatch", address: entry.address, nodeId: entry.nodeId, message: `dispatch hint ${runId} names node ${entry.nodeId}, not ${assembly.node.id}` });
			continue;
		}
		if (entry.worktreePath !== worktreePath) {
			findings.push({ code: "cache-dispatch-target-mismatch", runId, expected: worktreePath, actual: entry.worktreePath, message: `dispatch hint ${runId} belongs to worktree ${entry.worktreePath}, not ${worktreePath}` });
			continue;
		}
		dispatch[runId] = entry;
	}
	return { observations, review, dispatch, findings };
}

export function cacheEntry(update: ObservedVerificationCacheUpdate, address: NodeAddress): StatusCacheVerificationEntry {
	return { address: [...address], update };
}
