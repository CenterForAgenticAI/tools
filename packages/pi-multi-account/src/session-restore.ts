import type { Api, Model } from "@earendil-works/pi-ai";

/** Session fields used to recover an explicit model selection. */
interface ModelChangeEntryLike {
	readonly type: string;
	readonly provider?: unknown;
	readonly modelId?: unknown;
}

/** Session fields used to recover the model that completed an assistant turn. */
interface MessageEntryLike {
	readonly type: string;
	readonly message?: unknown;
}

interface AssistantMessageLike {
	readonly role?: unknown;
	readonly provider?: unknown;
	readonly model?: unknown;
	readonly stopReason?: unknown;
}

interface IndexedSelection {
	readonly index: number;
	readonly selection: PersistedModelSelection;
}

interface SessionRestoreEvidence {
	/** Newest valid model change, retained for the existing restore precedence. */
	readonly modelChange?: IndexedSelection;
	/** The newest model_change entry only when that exact entry is valid evidence. */
	readonly latestModelChange?: IndexedSelection;
	/** Index of the newest model_change even when its identity fields are malformed. */
	readonly latestModelChangeIndex?: number;
	readonly assistant?: IndexedSelection;
}

/** The read-only session surface this module consumes. */
export interface SessionBranchReader {
	getBranch: () => readonly unknown[];
}

/** A persisted model selection recovered from session history. */
export interface PersistedModelSelection {
	readonly provider: string;
	readonly modelId: string;
}

/**
 * Why a managed-alias restore did not (or did not need to) happen. Every value
 * is a bounded enum member so diagnostics never carry session text.
 */
export type RestoreOutcome =
	| "restored"
	| "no-persisted-selection"
	| "unmanaged-provider"
	| "already-active"
	| "model-unavailable"
	| "model-lookup-failed"
	| "set-model-rejected"
	| "set-model-failed";

function boundedSelection(
	provider: unknown,
	modelId: unknown,
): PersistedModelSelection | undefined {
	if (typeof provider !== "string" || provider.length === 0 || provider.length > 256) {
		return undefined;
	}
	if (typeof modelId !== "string" || modelId.length === 0 || modelId.length > 256) {
		return undefined;
	}
	return { provider, modelId };
}

function isCompletedAssistantStopReason(value: unknown): boolean {
	return value === "stop" || value === "length" || value === "toolUse";
}

/** Read only the identity fields needed for restore, and fail soft on hostile history. */
function sessionRestoreEvidence(
	session: SessionBranchReader,
): SessionRestoreEvidence | undefined {
	try {
		const branch = session.getBranch();
		if (!Array.isArray(branch)) return undefined;
		let modelChange: IndexedSelection | undefined;
		let latestModelChange: IndexedSelection | undefined;
		let latestModelChangeIndex: number | undefined;
		let assistant: IndexedSelection | undefined;
		for (let index = branch.length - 1; index >= 0; index -= 1) {
			const entry = branch[index] as
				| ModelChangeEntryLike
				| MessageEntryLike
				| null
				| undefined;
			if (!entry || typeof entry !== "object") continue;
			if (entry.type === "model_change") {
				const candidate = entry as ModelChangeEntryLike;
				const selection = boundedSelection(candidate.provider, candidate.modelId);
				if (latestModelChangeIndex === undefined) {
					latestModelChangeIndex = index;
					if (selection !== undefined) latestModelChange = { index, selection };
				}
				if (modelChange === undefined && selection !== undefined) {
					modelChange = { index, selection };
				}
			}
			if (assistant === undefined && entry.type === "message") {
				const message = (entry as MessageEntryLike).message as
					| AssistantMessageLike
					| null
					| undefined;
				if (
					message &&
					typeof message === "object" &&
					message.role === "assistant" &&
					isCompletedAssistantStopReason(message.stopReason)
				) {
					const selection = boundedSelection(message.provider, message.model);
					if (selection !== undefined) assistant = { index, selection };
				}
			}
			if (modelChange !== undefined && assistant !== undefined) break;
		}
		return {
			...(modelChange === undefined ? {} : { modelChange }),
			...(latestModelChange === undefined ? {} : { latestModelChange }),
			...(latestModelChangeIndex === undefined
				? {}
				: { latestModelChangeIndex }),
			...(assistant === undefined ? {} : { assistant }),
		};
	} catch {
		return undefined;
	}
}

/**
 * Extracts the selection Pi should restore from a restored session branch.
 *
 * An explicit `model_change` is authoritative even when a later assistant
 * message still belongs to the previously active model. When no valid explicit
 * selection exists, the newest completed assistant identifies the provider and
 * model that actually served the session. Failed, aborted, pending, and
 * deferred assistants are never restore evidence.
 *
 * Pi's own restore runs inside `createAgentSession`, strictly BEFORE extensions
 * load, so a managed alias provider does not exist yet at that point and the
 * host silently falls back to a base provider. Reading the branch at
 * `session_start` recovers the selection once the alias has been registered.
 *
 * Only provider, model, and stop-reason metadata is inspected. Message content,
 * tool output, and every other session field are ignored.
 */
export function lastPersistedModelSelection(
	session: SessionBranchReader,
): PersistedModelSelection | undefined {
	const evidence = sessionRestoreEvidence(session);
	return evidence?.modelChange?.selection ?? evidence?.assistant?.selection;
}

function exactModels(
	models: readonly Model<Api>[],
	selection: PersistedModelSelection,
): readonly Model<Api>[] {
	return models.filter(
		(model) =>
			model.provider === selection.provider && model.id === selection.modelId,
	);
}

/**
 * Map one legacy physical terminal back to the logical provider only when every
 * D6 predicate proves that the mapping is current and unique.
 */
export function resolveLegacyUnifiedSelection(input: {
	readonly origin: PersistedModelSelection | undefined;
	readonly physical: PersistedModelSelection;
	readonly logicalProviderId: string;
	readonly isManagedPhysicalSelection: (
		selection: PersistedModelSelection,
	) => boolean;
	readonly findModels: (
		selection: PersistedModelSelection,
	) => readonly Model<Api>[];
}): PersistedModelSelection {
	const physical = {
		provider: input.physical.provider,
		modelId: input.physical.modelId,
	};
	if (input.origin?.provider !== input.logicalProviderId) return physical;
	if (physical.provider === input.logicalProviderId) return physical;
	if (!input.isManagedPhysicalSelection(physical)) return physical;
	const logical = {
		provider: input.logicalProviderId,
		modelId: physical.modelId,
	};
	const physicalMatches = exactModels(input.findModels(physical), physical);
	if (physicalMatches.length !== 1) return physical;
	const logicalMatches = exactModels(input.findModels(logical), logical);
	return logicalMatches.length === 1 ? logical : physical;
}

/**
 * Reinstates the operator's persisted managed-alias model after the extension
 * has registered its alias providers.
 *
 * This is deliberately narrow: it acts only when the persisted provider is one
 * this extension manages AND the host did not already restore it. A session
 * whose last selection was an unmanaged provider is left untouched, so this
 * never overrides the host's own restore or a base-provider choice.
 */
export async function restoreManagedAliasModel(input: {
	readonly session: SessionBranchReader;
	readonly currentProviderId: string | undefined;
	readonly isManagedProvider: (providerId: string) => boolean;
	readonly findModel: (
		selection: PersistedModelSelection,
	) => Model<Api> | undefined;
	readonly setModel: (model: Model<Api>) => Promise<boolean>;
	readonly logicalProviderId?: string;
	readonly isManagedPhysicalSelection?: (
		selection: PersistedModelSelection,
	) => boolean;
	readonly findModels?: (
		selection: PersistedModelSelection,
	) => readonly Model<Api>[];
}): Promise<RestoreOutcome> {
	const evidence = sessionRestoreEvidence(input.session);
	const persisted = evidence?.modelChange?.selection ?? evidence?.assistant?.selection;
	if (!persisted) return "no-persisted-selection";

	let selection = persisted;
	const legacyPhysical = evidence?.assistant;
	const unifiedOrigin = evidence?.latestModelChange;
	const latestModelChangeIndex = evidence?.latestModelChangeIndex;
	if (
		legacyPhysical !== undefined &&
		latestModelChangeIndex !== undefined &&
		legacyPhysical.index > latestModelChangeIndex &&
		input.logicalProviderId !== undefined &&
		legacyPhysical.selection.provider !== input.logicalProviderId &&
		input.isManagedPhysicalSelection !== undefined &&
		input.findModels !== undefined
	) {
		try {
			selection = resolveLegacyUnifiedSelection({
				origin: unifiedOrigin?.selection,
				physical: legacyPhysical.selection,
				logicalProviderId: input.logicalProviderId,
				isManagedPhysicalSelection: input.isManagedPhysicalSelection,
				findModels: input.findModels,
			});
		} catch {
			return "model-lookup-failed";
		}
	}

	let managed: boolean;
	try {
		managed = input.isManagedProvider(selection.provider);
	} catch {
		return "model-lookup-failed";
	}
	if (!managed) return "unmanaged-provider";
	if (selection.provider === input.currentProviderId) return "already-active";

	let model: Model<Api> | undefined;
	try {
		model = input.findModel(selection);
	} catch {
		return "model-lookup-failed";
	}
	if (
		model === undefined ||
		model.provider !== selection.provider ||
		model.id !== selection.modelId
	) {
		return "model-unavailable";
	}
	try {
		return (await input.setModel(model)) ? "restored" : "set-model-rejected";
	} catch {
		return "set-model-failed";
	}
}
