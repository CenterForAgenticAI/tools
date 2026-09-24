import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { fuzzyMatch } from "./fuzzy.js";
import {
	accountSlotIndexes,
	canonicalProviderIdForAccountSlot,
	isAccountLimit,
	isAccountSlotIndex,
	MANAGED_FAMILIES,
	MAX_ACCOUNT_LIMIT,
	type ManagedFamily,
} from "./config.js";
import {
	isProviderSlotWithinAccountLimit,
	type ProviderSlot,
} from "./discovery.js";
import {
	resolveLogicalModelReference,
	type LogicalModelCandidate,
	type LogicalModelInventory,
} from "./logical-model-switcher.js";
import { LOGICAL_PROVIDER_ID } from "./models-declaration.js";
import {
	MULTI_ACCOUNT_SUBCOMMANDS,
	type MultiAccountSubcommand,
} from "./commands.js";
import { PERIOD_TYPES } from "./period-boundaries.js";

/**
 * Pure, synchronous, order-preserving, fail-soft completion policy for the two
 * multi-account commands. It parses only the argument prefix after the command's
 * first literal separator, never executes a command, and never reads a
 * credential, model, or human label. Every emitted item is newly copied from
 * named fields.
 */

/** The exact source-backed `log` anchors; there is no suggestion for every integer. */
const LOG_COMPLETION_CHOICES = ["1", "20", "50", "100"] as const;

/** Whole-prefix bound shared by both commands. */
const MAX_ARGUMENT_PREFIX_LENGTH = 1_024;

/** Rejects tabs, newlines, and every other ASCII control while allowing a space. */
const CONTROL_CHARACTER = /[\u0000-\u0019\u001b-\u001f\u007f]/;

/**
 * Matches any Unicode whitespace. A logical model ID may contain `/` but no
 * whitespace; a whitespace-bearing candidate would produce a multi-token
 * completion value that Pi could not replace as one argument, so it is excluded.
 */
const WHITESPACE = /\s/u;

export type CompletionAccountIdentity = Readonly<{
	providerId: string;
	family: ManagedFamily;
}>;

export type CompletionSlotChoices = Readonly<
	Record<ManagedFamily, readonly string[]>
>;

export type MultiAccountCompletionSnapshot = Readonly<{
	accounts: readonly CompletionAccountIdentity[];
	addSlots: CompletionSlotChoices;
	groupIds: readonly string[];
	logicalModels: LogicalModelInventory;
}>;

/**
 * Projects the account identities completion may offer as bare direct
 * command arguments: only discovered slots within the current limit that also
 * back a live model, copied to named fields.
 */
export function projectCompletionAccounts(
	input: Readonly<{
		slots: readonly ProviderSlot[];
		accountLimit: number;
		hasLiveModel: (providerId: string) => boolean;
	}>,
): readonly CompletionAccountIdentity[] {
	const accounts: CompletionAccountIdentity[] = [];
	for (const slot of input.slots) {
		if (!isProviderSlotWithinAccountLimit(slot, input.accountLimit)) continue;
		if (!input.hasLiveModel(slot.providerId)) continue;
		accounts.push({ providerId: slot.providerId, family: slot.family });
	}
	return accounts;
}

/**
 * Projects the ascending, current, free, in-range numbered add slots per
 * family from validated config, separately validated occupancy, and Codex
 * availability. It consumes the sole shared iterator and revalidates every
 * yield; it never copies the numeric maximum or writes its own increment loop.
 */
export function projectCompletionAddSlots(
	input: Readonly<{
		slots: readonly ProviderSlot[];
		spareProviderIds: readonly string[];
		accountLimit: number;
		codexEnabled: boolean;
	}>,
): CompletionSlotChoices {
	const effectiveLimit = input.accountLimit;
	if (!isAccountLimit(effectiveLimit)) {
		return {
			anthropic: [],
			"openai-codex": [],
			"google-antigravity": [],
			openai: [],
		};
	}
	const occupied = new Set<string>();
	for (const slot of input.slots) occupied.add(slot.providerId);
	for (const spare of input.spareProviderIds) occupied.add(spare);
	const choices: Record<ManagedFamily, string[]> = {
		anthropic: [],
		"openai-codex": [],
		"google-antigravity": [],
		openai: [],
	};
	for (const family of MANAGED_FAMILIES) {
		if (family === "openai-codex" && !input.codexEnabled) continue;
		for (const index of accountSlotIndexes(effectiveLimit, 2)) {
			if (!isAccountSlotIndex(index, effectiveLimit)) continue;
			if (index < 2) continue;
			const providerId = canonicalProviderIdForAccountSlot(
				family,
				index,
				effectiveLimit,
			);
			if (providerId === null) continue;
			if (occupied.has(providerId)) continue;
			choices[family].push(String(index));
		}
	}
	return choices;
}

type GrammarChoice = Readonly<{
	text: string;
	account?: CompletionAccountIdentity;
}>;

interface GrammarLevel {
	readonly head: string;
	readonly choices: readonly GrammarChoice[];
	isNonterminal(text: string): boolean;
	descend(text: string): GrammarLevel | null;
}

interface RootSpec {
	token2(snapshot: MultiAccountCompletionSnapshot): readonly GrammarChoice[] | null;
}

function accountChoices(
	snapshot: MultiAccountCompletionSnapshot,
): GrammarChoice[] {
	return snapshot.accounts.map((account) => ({
		text: account.providerId,
		account,
	}));
}

function familyChoices(): GrammarChoice[] {
	return MANAGED_FAMILIES.map((family) => ({ text: family }));
}

const ROOT_TABLE: Partial<Record<MultiAccountSubcommand, RootSpec>> = {
	status: {
		token2: (snapshot) => [{ text: "--json" }, ...accountChoices(snapshot)],
	},
	limits: { token2: () => null },
	models: {
		token2: (snapshot) => [
			{ text: "install" },
			{ text: "update" },
			...accountChoices(snapshot),
		],
	},
	// The nested logical-model projection is custom because its display label and
	// fuzzy search fields differ from its inserted value. An empty token source
	// marks this root as open; completeMultiAccountArguments delegates below.
	model: { token2: () => [] },
	cost: { token2: () => PERIOD_TYPES.map((period) => ({ text: period })) },
	log: { token2: () => LOG_COMPLETION_CHOICES.map((anchor) => ({ text: anchor })) },
	rediscover: { token2: () => null },
	add: { token2: () => familyChoices() },
	remove: { token2: (snapshot) => accountChoices(snapshot) },
	clear: { token2: (snapshot) => accountChoices(snapshot) },
	next: { token2: () => null },
	switch: { token2: (snapshot) => accountChoices(snapshot) },
	stop: { token2: () => null },
	reset: { token2: () => null },
	reload: { token2: () => null },
	configure: { token2: () => null },
	enable: { token2: () => null },
	disable: { token2: () => familyChoices() },
	group: {
		token2: () => [{ text: "use" }, { text: "reset" }, { text: "status" }],
	},
};

const ROOT_ORDER: readonly MultiAccountSubcommand[] =
	MULTI_ACCOUNT_SUBCOMMANDS.filter((root) => ROOT_TABLE[root] !== undefined);

function rootSpec(text: string): RootSpec | undefined {
	return (ROOT_TABLE as Record<string, RootSpec | undefined>)[text];
}

function isManagedFamilyText(text: string): text is ManagedFamily {
	return (MANAGED_FAMILIES as readonly string[]).includes(text);
}

function buildGrammarItem(head: string, choice: GrammarChoice): AutocompleteItem {
	const value = head === "" ? choice.text : `${head} ${choice.text}`;
	if (choice.account !== undefined) {
		return { value, label: value };
	}
	return { value, label: value };
}

function terminalTokenLevel(
	head: string,
	choices: readonly GrammarChoice[],
): GrammarLevel {
	return {
		head,
		choices,
		isNonterminal: () => false,
		descend: () => null,
	};
}

function token2Level(
	root: MultiAccountSubcommand,
	source: readonly GrammarChoice[],
	snapshot: MultiAccountCompletionSnapshot,
): GrammarLevel {
	return {
		head: root,
		choices: source,
		isNonterminal: (text) =>
			(root === "add" && isManagedFamilyText(text)) ||
			(root === "group" && text === "use"),
		descend: (text) => {
			if (root === "add" && isManagedFamilyText(text)) {
				return terminalTokenLevel(
					`${root} ${text}`,
					snapshot.addSlots[text].map((slot) => ({ text: slot })),
				);
			}
			if (root === "group" && text === "use") {
				return terminalTokenLevel(
					"group use",
					snapshot.groupIds.map((groupId) => ({ text: groupId })),
				);
			}
			return null;
		},
	};
}

function rootLevel(snapshot: MultiAccountCompletionSnapshot): GrammarLevel {
	return {
		head: "",
		choices: ROOT_ORDER.map((root) => ({ text: root })),
		isNonterminal: (text) => {
			const spec = rootSpec(text);
			return spec !== undefined && spec.token2(snapshot) !== null;
		},
		descend: (text) => {
			const spec = rootSpec(text);
			if (spec === undefined) return null;
			const source = spec.token2(snapshot);
			if (source === null) return null;
			return token2Level(text as MultiAccountSubcommand, source, snapshot);
		},
	};
}

function classifyGrammar(
	level: GrammarLevel,
	current: string,
	trailing: boolean,
): AutocompleteItem[] | null {
	if (current === "") {
		if (level.choices.length === 0) return null;
		return level.choices.map((choice) => buildGrammarItem(level.head, choice));
	}
	const exact = level.choices.find((choice) => choice.text === current);
	if (exact !== undefined) {
		if (level.isNonterminal(exact.text)) {
			const next = level.descend(exact.text);
			if (next === null) return null;
			return classifyGrammar(next, "", false);
		}
		return null;
	}
	if (!trailing) {
		const matched = level.choices.filter(
			(choice) => fuzzyMatch(current, choice.text).matches,
		);
		if (matched.length === 0) return null;
		return matched.map((choice) => buildGrammarItem(level.head, choice));
	}
	return null;
}

function parseCommandPrefix(
	prefix: string,
): { completed: string[]; current: string; trailing: boolean } | null {
	if (prefix.length > MAX_ARGUMENT_PREFIX_LENGTH) return null;
	if (CONTROL_CHARACTER.test(prefix)) return null;
	if (prefix === "") return { completed: [], current: "", trailing: false };
	if (prefix.startsWith(" ")) return null;
	const trailing = prefix.endsWith(" ");
	const core = trailing ? prefix.slice(0, -1) : prefix;
	if (core === "") return null;
	const raw = core.split(" ");
	if (raw.some((token) => token === "")) return null;
	const completed = trailing ? raw : raw.slice(0, -1);
	const current = trailing ? "" : (raw[raw.length - 1] ?? "");
	return { completed, current, trailing };
}

/**
 * Completes `/multi-account` arguments through the finite command grammar.
 * Returns whole-prefix replacement items or `null`; never mutates inputs or
 * process state.
 */
export function completeMultiAccountArguments(
	argumentPrefix: string,
	snapshot: MultiAccountCompletionSnapshot,
): AutocompleteItem[] | null {
	const parsed = parseCommandPrefix(argumentPrefix);
	if (parsed === null) return null;
	if (argumentPrefix === "model" || argumentPrefix.startsWith("model ")) {
		const logicalPrefix =
			argumentPrefix === "model" ? "" : argumentPrefix.slice("model ".length);
		const items = completeLogicalModelArguments(
			logicalPrefix,
			snapshot.logicalModels,
		);
		return items?.map((item) => ({
			value: `model ${item.value}`,
			label: item.label,
		})) ?? null;
	}
	let level = rootLevel(snapshot);
	for (const token of parsed.completed) {
		const next = level.descend(token);
		if (next === null) return null;
		level = next;
	}
	return classifyGrammar(level, parsed.current, parsed.trailing);
}

/**
 * Completes `/multi-account-model` arguments from a fresh logical inventory.
 * Emits bare-ID values with display-only `<id> [unified]` labels, excludes
 * physical, ambiguous, unavailable, and out-of-scope candidates, and closes an
 * exact retained bare ID. Returns `null` on no match or any closed inventory.
 */
export function completeLogicalModelArguments(
	argumentPrefix: string,
	inventory: LogicalModelInventory,
): AutocompleteItem[] | null {
	if (argumentPrefix.length > MAX_ARGUMENT_PREFIX_LENGTH) return null;
	if (CONTROL_CHARACTER.test(argumentPrefix)) return null;
	if (argumentPrefix.startsWith(" ")) return null;
	if (argumentPrefix.includes(" ")) return null;
	if (inventory.status !== "ready") return null;
	const candidates = inventory.candidates;
	const query = argumentPrefix;
	const retained: LogicalModelCandidate[] = [];
	for (const candidate of candidates) {
		if (WHITESPACE.test(candidate.id)) continue;
		if (
			candidate.model.provider !== LOGICAL_PROVIDER_ID ||
			candidate.model.api !== LOGICAL_PROVIDER_ID
		)
			continue;
		const reference = resolveLogicalModelReference(candidate.id, inventory);
		if (reference.status !== "resolved" || reference.candidate.id !== candidate.id)
			continue;
		retained.push(candidate);
	}
	if (query !== "" && retained.some((candidate) => candidate.id === query)) {
		return null;
	}
	const matched = retained.filter(
		(candidate) =>
			fuzzyMatch(
				query,
				`unified pi-multi-account ${LOGICAL_PROVIDER_ID}/${candidate.id} ${candidate.id} ${candidate.name}`,
			).matches,
	);
	if (matched.length === 0) return null;
	return matched.map((candidate) => {
		const id = candidate.id;
		const label = `${id} [unified]`;
		return { value: id, label };
	});
}
