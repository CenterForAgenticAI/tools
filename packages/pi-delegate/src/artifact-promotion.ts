/** Explicitly copy one worker-workspace artifact into context-aware's cache. */

import {
	openWorkerArtifact,
	type OpenWorkerArtifact,
	type WorkerArtifactReference,
} from "./artifact-workspace.js";

const CONTEXT_AWARE_CONTEXT_SERVICE_MODULE_IDS = [
	"@caair/pi-context-aware/context-service",
	"@centerforagenticai/pi-context-aware/context-service",
] as const;
const ARTIFACT_PROMOTION_CONSUMER_ID = "@caair/pi-delegate/artifact-promotion";

/** The narrow event-bus surface used by context-aware's synchronous discovery handshake. */
export interface ContextAwareArtifactPromotionEventBus {
	emit(event: string, data: unknown): void;
}

/** Mirrors the optional context-aware protocol-v1 cache reference. */
export interface ContextAwareArtifactReferenceV1 {
	kind: "context-cache-artifact";
	id: string;
	name: string;
	uri: string;
	path: string;
	description: string;
	sizeBytes: number;
	updated: string;
	createdBy: string;
	updatedBy: string;
}

/** Mirrors the request accepted by context-aware's promotion validator. */
export interface ContextAwareArtifactPromotionRequestV1 {
	sourcePath: string;
	file: string;
	description?: string;
}

export type ContextAwareArtifactPromotionFailureCodeV1 =
	| "INVALID_REQUEST"
	| "SERVICE_UNAVAILABLE"
	| "CACHE_DISABLED"
	| "SOURCE_UNAVAILABLE"
	| "PROMOTION_FAILED";

export type ContextAwareArtifactPromotionResultV1 =
	| { status: "promoted"; artifact: ContextAwareArtifactReferenceV1 }
	| { status: "failed"; code: ContextAwareArtifactPromotionFailureCodeV1; message: string };

/** The additive slice of ContextAwareServiceV1 needed for artifact promotion. */
export interface ContextAwareArtifactPromotionServiceV1 {
	readonly protocolVersion: 1;
	promoteArtifact?(request: ContextAwareArtifactPromotionRequestV1): ContextAwareArtifactPromotionResultV1;
}

export type ContextAwareArtifactPromotionValidationResultV1 =
	| { ok: true; request: ContextAwareArtifactPromotionRequestV1 }
	| { ok: false; code: "INVALID_REQUEST"; message: string };

/** Runtime exports used from the optional context-aware package. */
export interface ContextAwareArtifactPromotionModuleV1 {
	discoverContextAwareServiceV1(
		events: ContextAwareArtifactPromotionEventBus,
		consumerId: string,
	): ContextAwareArtifactPromotionServiceV1 | undefined;
	supportsContextAwareArtifactPromotionV1(
		service: ContextAwareArtifactPromotionServiceV1 | undefined,
	): boolean;
	validateContextAwareArtifactPromotionRequestV1(
		request: ContextAwareArtifactPromotionRequestV1,
	): ContextAwareArtifactPromotionValidationResultV1;
}

export type WorkerArtifactPromotionSkipReason =
	| "context-aware-unavailable"
	| "service-unavailable"
	| "promotion-unsupported";

/** Structured outcome returned to an explicit coordinator caller. */
export type WorkerArtifactPromotionResult =
	| { status: "promoted"; artifact: ContextAwareArtifactReferenceV1 }
	| { status: "skipped"; reason: WorkerArtifactPromotionSkipReason; diagnostic: string }
	| { status: "error"; code: ContextAwareArtifactPromotionFailureCodeV1; diagnostic: string };

export interface PromoteWorkerArtifactArgs {
	/** Event bus for the current Pi session runtime. */
	events: ContextAwareArtifactPromotionEventBus;
	/** Exact retained artifact returned by the producing run. */
	artifactRef?: WorkerArtifactReference;
	description?: string;
	/** @deprecated V1 basename lookup was removed; pass artifactRef. */
	worktreePath?: string;
	/** @deprecated V1 basename lookup was removed; pass artifactRef. */
	artifactName?: string;
}

/** Injectable only at the optional-package boundary; production callers use the default loader. */
export interface PromoteWorkerArtifactDependencies {
	loadContextServiceModule?: (moduleId: string) => Promise<unknown>;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function openPromotionSource(args: PromoteWorkerArtifactArgs): Promise<OpenWorkerArtifact> {
	if (args.artifactRef === undefined) {
		throw new Error("Artifact promotion requires the exact returned artifactRef; worktree/name lookup has no v2 fallback.");
	}
	return openWorkerArtifact(args.artifactRef);
}

async function importContextServiceModule(moduleId: string): Promise<unknown> {
	// Keep the package optional: using a variable prevents TypeScript from turning
	// this runtime capability check into a build-time module dependency.
	return import(moduleId);
}

class ContextServiceModulesUnavailableError extends AggregateError {}

function packageNameFromModuleId(moduleId: string): string {
	const segments = moduleId.split("/");
	return moduleId.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]!;
}

function missingModuleTarget(message: string): string | undefined {
	return /^Cannot find (?:package|module) (["'])([^"']+)\1 imported from .+$/u.exec(message)?.[2];
}

function moduleNotFoundFor(error: unknown, moduleId: string): boolean {
	if (typeof error !== "object" || error === null) return false;
	const code = "code" in error ? error.code : undefined;
	const message = "message" in error ? error.message : undefined;
	if ((code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") || typeof message !== "string") {
		return false;
	}
	const missingTarget = missingModuleTarget(message);
	if (missingTarget === undefined) return false;
	const packageName = packageNameFromModuleId(moduleId);
	return missingTarget === packageName || missingTarget === moduleId;
}

async function loadContextServiceModule(
	loader: (moduleId: string) => Promise<unknown> = importContextServiceModule,
): Promise<unknown> {
	const errors: unknown[] = [];
	for (const moduleId of CONTEXT_AWARE_CONTEXT_SERVICE_MODULE_IDS) {
		try {
			return await loader(moduleId);
		} catch (error) {
			if (!moduleNotFoundFor(error, moduleId)) throw error;
			errors.push(error);
		}
	}
	throw new ContextServiceModulesUnavailableError(
		errors,
		`Unable to load the optional context-aware service from ${CONTEXT_AWARE_CONTEXT_SERVICE_MODULE_IDS.join(" or ")}`,
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContextServiceModule(
	value: unknown,
): value is ContextAwareArtifactPromotionModuleV1 {
	return isRecord(value) &&
		typeof value.discoverContextAwareServiceV1 === "function" &&
		typeof value.supportsContextAwareArtifactPromotionV1 === "function" &&
		typeof value.validateContextAwareArtifactPromotionRequestV1 === "function";
}

function skipped(
	reason: WorkerArtifactPromotionSkipReason,
	diagnostic: string,
): WorkerArtifactPromotionResult {
	return { status: "skipped", reason, diagnostic };
}

/**
 * Promote exactly one named artifact. Nothing calls this function automatically;
 * the coordinator must invoke this public entry point for the current session.
 */
export async function promoteWorkerArtifact(
	args: PromoteWorkerArtifactArgs,
	dependencies: PromoteWorkerArtifactDependencies = {},
): Promise<WorkerArtifactPromotionResult> {
	const source = await openPromotionSource(args);
	const sourcePath = source.outputFile.absolutePath;
	const artifactName = source.artifactRef.artifactName;
	try {
	let loaded: unknown;
	try {
		loaded = await loadContextServiceModule(dependencies.loadContextServiceModule);
	} catch (error) {
		if (!(error instanceof ContextServiceModulesUnavailableError)) throw error;
		return skipped(
			"context-aware-unavailable",
			`Artifact ${JSON.stringify(artifactName)} was not promoted because the optional ` +
			`${CONTEXT_AWARE_CONTEXT_SERVICE_MODULE_IDS.join(" or ")} service could not be loaded: ${errorMessage(error)}`,
		);
	}
	if (!isContextServiceModule(loaded)) {
		return skipped(
			"promotion-unsupported",
			`Artifact ${JSON.stringify(artifactName)} was not promoted because the installed context-aware service ` +
			"does not expose the protocol-v1 artifact promotion helpers.",
		);
	}

	let service: ContextAwareArtifactPromotionServiceV1 | undefined;
	try {
		service = loaded.discoverContextAwareServiceV1(args.events, ARTIFACT_PROMOTION_CONSUMER_ID);
	} catch (error) {
		return skipped(
			"service-unavailable",
			`Artifact ${JSON.stringify(artifactName)} was not promoted because context-aware service discovery ` +
			`failed for the current session: ${errorMessage(error)}`,
		);
	}
	if (service === undefined) {
		return skipped(
			"service-unavailable",
			`Artifact ${JSON.stringify(artifactName)} was not promoted because no context-aware service ` +
			"was discovered for the current session.",
		);
	}
	if (!loaded.supportsContextAwareArtifactPromotionV1(service) || typeof service.promoteArtifact !== "function") {
		return skipped(
			"promotion-unsupported",
			`Artifact ${JSON.stringify(artifactName)} was not promoted because the context-aware service ` +
			"does not support artifact promotion.",
		);
	}

	const request: ContextAwareArtifactPromotionRequestV1 = {
		sourcePath,
		file: artifactName,
		...(args.description === undefined ? {} : { description: args.description }),
	};
	let validation: ContextAwareArtifactPromotionValidationResultV1;
	try {
		validation = loaded.validateContextAwareArtifactPromotionRequestV1(request);
	} catch (error) {
		return {
			status: "error",
			code: "INVALID_REQUEST",
			diagnostic: `Artifact ${JSON.stringify(artifactName)} was not promoted because request validation failed: ${errorMessage(error)}`,
		};
	}
	if (validation.ok === false) {
		return {
			status: "error",
			code: validation.code,
			diagnostic: `Artifact ${JSON.stringify(artifactName)} was not promoted: ${validation.message}`,
		};
	}

	let result: ContextAwareArtifactPromotionResultV1;
	try {
		result = service.promoteArtifact(validation.request);
	} catch (error) {
		return {
			status: "error",
			code: "PROMOTION_FAILED",
			diagnostic: `Artifact ${JSON.stringify(artifactName)} was not promoted: ${errorMessage(error)}`,
		};
	}
	if (result.status === "promoted") return result;
	return {
		status: "error",
		code: result.code,
		diagnostic: `Artifact ${JSON.stringify(artifactName)} was not promoted: ${result.message}`,
	};
	} finally {
		await source.release();
	}
}
