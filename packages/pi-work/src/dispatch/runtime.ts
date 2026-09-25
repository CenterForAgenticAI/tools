import path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type {
	DelegateClientAvailability,
	DelegateDispatchClient,
	DelegateRuntimeErrorCode,
	DelegateRuntimeForkReceipt,
	DelegateRuntimeInputDigest,
	DelegateRuntimeReceipt,
} from "./types.js";

const DELEGATE_MODULE_IDS = ["@caair/pi-delegate", "@centerforagenticai/pi-delegate"] as const;
/**
 * Handle the loaded pi-delegate extension publishes on `globalThis` while its
 * runtime core is installed. The runtime client works only through that live
 * instance: a separately resolved copy of the package has no installed core and
 * fails every dispatch with `core-unavailable`. pi-delegate is also installed
 * as its own package, so a bare import from pi-work usually cannot resolve it.
 */
const DELEGATE_RUNTIME_API_HANDLE_KEY = Symbol.for("pi-delegate.runtime-api.v1");
export type DelegateRuntimeModuleLoader = () => Promise<unknown>;
export type DelegateRuntimeModuleImporter = (moduleId: string) => Promise<unknown>;

const importModule: DelegateRuntimeModuleImporter = (moduleId) => import(moduleId);

function barePackageName(moduleId: string): string {
	const segments = moduleId.split("/");
	return moduleId.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0] ?? moduleId;
}

function moduleNotFoundFor(error: unknown, moduleId: string): boolean {
	if (typeof error !== "object" || error === null) return false;
	const code = "code" in error ? error.code : undefined;
	const message = "message" in error ? error.message : undefined;
	if ((code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") || typeof message !== "string") return false;
	const missingTarget = /^Cannot find (?:package|module) ['"]([^'"]+)['"]/.exec(message)?.[1];
	return missingTarget === moduleId || missingTarget === barePackageName(moduleId);
}

export async function importDelegateRuntime(importer: DelegateRuntimeModuleImporter = importModule): Promise<unknown> {
	const handle = (globalThis as Record<symbol, unknown>)[DELEGATE_RUNTIME_API_HANDLE_KEY];
	if (handle !== undefined) return handle;
	let finalError: unknown;
	for (const moduleId of DELEGATE_MODULE_IDS) {
		try {
			return await importer(moduleId);
		} catch (error) {
			if (!moduleNotFoundFor(error, moduleId)) throw error;
			finalError = error;
		}
	}
	throw finalError;
}
const RUNTIME_ERROR_CODES = new Set<DelegateRuntimeErrorCode>([
	"core-unavailable",
	"invalid-request",
	"unsupported-option",
	"input-unreadable",
	"unknown-agent",
	"model-unavailable",
	"invalid-confinement",
	"not-found",
	"control-unavailable",
	"core-error",
	"provenance-unavailable",
]);

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const expected = [...keys].sort();
	const actual = Object.keys(value).sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function validTimestamp(value: unknown): value is string {
	return nonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function validSha256(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function decodeInputDigest(value: unknown): DelegateRuntimeInputDigest | undefined {
	// `focus` joins the accepted kinds with the handoff.focus carrier: the runtime
	// records one digest per namespace, and an unrecognized kind fails the whole
	// receipt closed rather than dropping that one digest.
	if (!record(value) || !exactKeys(value, ["kind", "name", "algorithm", "digest"]) || (value.kind !== "task" && value.kind !== "read" && value.kind !== "checklist" && value.kind !== "focus") || !nonEmptyString(value.name) || value.algorithm !== "sha256" || !validSha256(value.digest)) return undefined;
	return { kind: value.kind, name: value.name, algorithm: "sha256", digest: value.digest };
}

function optionalString(value: Record<string, unknown>, key: string): boolean {
	return value[key] === undefined || nonEmptyString(value[key]);
}

function optionalBoolean(value: Record<string, unknown>, key: string): boolean {
	return value[key] === undefined || typeof value[key] === "boolean";
}

function decodeFork(value: unknown): DelegateRuntimeForkReceipt | undefined {
	if (!record(value)) return undefined;
	const allowed = new Set(["name", "agent", "workerCwd", "branch", "maxRounds", "cloneMode", "collapseMode", "confineWrites", "readOnly", "requestedModel", "resolvedModel", "skills", "inputDigests"]);
	if (Object.keys(value).some((key) => !allowed.has(key)) || !nonEmptyString(value.name) || !nonEmptyString(value.agent) || !Number.isInteger(value.maxRounds) || (value.maxRounds as number) < 1 || !optionalString(value, "workerCwd") || !optionalString(value, "branch") || !optionalString(value, "cloneMode") || !optionalString(value, "collapseMode") || !optionalBoolean(value, "confineWrites") || !optionalBoolean(value, "readOnly") || !optionalString(value, "requestedModel") || !optionalString(value, "resolvedModel") || !Array.isArray(value.inputDigests)) return undefined;
	if (value.workerCwd !== undefined && (!path.isAbsolute(value.workerCwd as string) || path.normalize(value.workerCwd as string) !== value.workerCwd)) return undefined;
	if (value.skills !== undefined && (!Array.isArray(value.skills) || value.skills.length === 0 || !value.skills.every(nonEmptyString))) return undefined;
	const inputDigests = value.inputDigests.map(decodeInputDigest);
	if (inputDigests.some((digest) => digest === undefined)) return undefined;
	return {
		name: value.name,
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
		inputDigests: inputDigests as DelegateRuntimeInputDigest[],
	};
}

/** Strictly decode the declaration-backed pi-delegate v1 receipt envelope. */
export function decodeDelegateRuntimeReceipt(value: unknown): DelegateRuntimeReceipt | undefined {
	if (!record(value) || !exactKeys(value, ["schema", "version", "runId", "createdAt", "shape", "forks", "receiptPath", "resultPath"]) || value.schema !== "pi-delegate.runtime-receipt" || value.version !== 1 || !nonEmptyString(value.runId) || !validTimestamp(value.createdAt) || !nonEmptyString(value.shape) || !Array.isArray(value.forks) || !nonEmptyString(value.receiptPath) || !path.isAbsolute(value.receiptPath) || path.normalize(value.receiptPath) !== value.receiptPath || !nonEmptyString(value.resultPath) || !path.isAbsolute(value.resultPath) || path.normalize(value.resultPath) !== value.resultPath) return undefined;
	const forks = value.forks.map(decodeFork);
	if (forks.some((fork) => fork === undefined)) return undefined;
	return {
		schema: "pi-delegate.runtime-receipt",
		version: 1,
		runId: value.runId,
		createdAt: value.createdAt,
		shape: value.shape,
		forks: forks as DelegateRuntimeForkReceipt[],
		receiptPath: value.receiptPath,
		resultPath: value.resultPath,
	};
}

export function delegateRuntimeErrorCode(error: unknown): DelegateRuntimeErrorCode | undefined {
	if (!record(error)) return undefined;
	return typeof error.code === "string" && RUNTIME_ERROR_CODES.has(error.code as DelegateRuntimeErrorCode) ? error.code as DelegateRuntimeErrorCode : undefined;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Load the optional peer without making standalone pi-work extension loading fail. */
export async function loadDelegateClient(context: ExtensionContext, loadModule: DelegateRuntimeModuleLoader = importDelegateRuntime): Promise<DelegateClientAvailability> {
	let runtimeModule: unknown;
	try {
		runtimeModule = await loadModule();
	} catch (error) {
		return { status: "unavailable", message: `pi-delegate runtime client is unavailable: ${errorMessage(error)}` };
	}
	if (!record(runtimeModule) || typeof runtimeModule.createDelegateRuntimeClient !== "function") {
		return { status: "unavailable", message: "pi-delegate does not export createDelegateRuntimeClient" };
	}
	const grammar = typeof runtimeModule.normalizeDelegateParams === "function" ? "canonical" : "legacy";
	try {
		const client = runtimeModule.createDelegateRuntimeClient({ context }) as unknown;
		if (!record(client) || typeof client.dispatch !== "function") return { status: "unavailable", message: "pi-delegate runtime client has no dispatch method" };
		const dispatch = client.dispatch.bind(client) as DelegateDispatchClient["dispatch"];
		return { status: "available", grammar, client: { dispatch } };
	} catch (error) {
		return { status: "unavailable", message: `pi-delegate runtime client could not be created: ${errorMessage(error)}` };
	}
}
