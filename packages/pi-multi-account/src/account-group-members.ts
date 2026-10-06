import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type GroupMemberRegistry = Pick<
	ExtensionContext["modelRegistry"],
	"getAll" | "getAvailable"
> & Partial<Pick<
	ExtensionContext["modelRegistry"],
	"getRegisteredProviderIds" | "getProviderAuthStatus"
>>;

export type AccountGroupMemberReason =
	| "recognized and available"
	| "excluded by active group"
	| "unknown or removed provider"
	| "authentication unavailable"
	| "model unavailable"
	| "virtual model unsupported by active group"
	| "authorization snapshot unavailable";

export interface AccountGroupMemberAvailability {
	readonly providerId: string;
	readonly eligible: boolean;
	readonly reason: AccountGroupMemberReason;
}

export interface AccountGroupRegistrySnapshot {
	readonly providerIds: ReadonlySet<string>;
	readonly modelProviderIds: ReadonlySet<string>;
	readonly availableModels: readonly {
		readonly providerId: string;
		readonly modelId: string;
		readonly api: string;
	}[] | undefined;
}

/** Public Pi virtual API marker; provider identity/auth cannot confine its targets. */
export function isAccountGroupVirtualModel(
	model: Readonly<{ api: string }> | undefined,
): boolean {
	return model?.api === "pi-virtual";
}

/** Syntax alone grants no authority and does not enroll a provider in routing. */
export function isAccountGroupMemberReference(
	value: unknown,
	accountLimit: number,
	managedFamilies: readonly string[],
): value is string {
	if (
		typeof value !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
	) return false;
	if (!Number.isInteger(accountLimit) || accountLimit < 1 || accountLimit > 32) {
		return false;
	}
	for (const family of managedFamilies) {
		if (value === family) return true;
		const prefix = `${family}-account-`;
		if (!value.startsWith(prefix)) continue;
		const suffix = value.slice(prefix.length);
		const slot = Number(suffix);
		return Number.isSafeInteger(slot) && slot >= 2 &&
			slot <= accountLimit && String(slot) === suffix;
	}
	return true;
}

/** Public synchronous snapshots only: no credential resolver, refresh, label or key. */
export function readAccountGroupRegistrySnapshot(
	registry: GroupMemberRegistry | undefined,
): AccountGroupRegistrySnapshot {
	const providerIds = new Set<string>();
	const modelProviderIds = new Set<string>();
	let availableModels: AccountGroupRegistrySnapshot["availableModels"];
	try {
		for (const row of registry?.getAll() ?? []) {
			providerIds.add(row.provider);
			modelProviderIds.add(row.provider);
		}
		for (const id of registry?.getRegisteredProviderIds?.() ?? []) {
			providerIds.add(id);
		}
	} catch {
		return {
			providerIds: new Set(), modelProviderIds: new Set(),
			availableModels: undefined,
		};
	}
	try {
		// getAvailable() is cached catalog/auth-check metadata, not resolved request
		// credentials. A configured command can pass without executing. A failed
		// metadata read excludes only its member; request auth remains host-owned.
		const authConfigured = new Map<string, boolean>();
		availableModels = registry?.getAvailable().filter((row) => {
			if (!authConfigured.has(row.provider)) {
				try {
					const configured = registry.getProviderAuthStatus === undefined ||
						registry.getProviderAuthStatus(row.provider).configured === true;
					authConfigured.set(row.provider, configured);
				} catch {
					authConfigured.set(row.provider, false);
				}
			}
			return authConfigured.get(row.provider) === true;
		}).map((row) => ({ providerId: row.provider, modelId: row.id, api: row.api }));
	} catch {
		availableModels = undefined;
	}
	return { providerIds, modelProviderIds, availableModels };
}

/** Exact membership and live availability, independent of managed routing ownership. */
export function accountGroupMemberAvailability(
	providerId: string,
	members: readonly string[],
	snapshot: AccountGroupRegistrySnapshot,
	modelId?: string,
): AccountGroupMemberAvailability {
	let reason: AccountGroupMemberReason;
	const available = snapshot.availableModels;
	if (!snapshot.providerIds.has(providerId)) reason = "unknown or removed provider";
	else if (!members.includes(providerId)) reason = "excluded by active group";
	else if (available === undefined) reason = "authorization snapshot unavailable";
	else if (!snapshot.modelProviderIds.has(providerId)) reason = "model unavailable";
	else if (!available.some((row) => row.providerId === providerId)) {
		reason = "authentication unavailable";
	} else if (modelId !== undefined && !available.some(
		(row) => row.providerId === providerId && row.modelId === modelId,
	)) {
		reason = "model unavailable";
	} else if (!available.some((row) =>
		row.providerId === providerId &&
		(modelId === undefined || row.modelId === modelId) &&
		!isAccountGroupVirtualModel(row),
	)) {
		reason = "virtual model unsupported by active group";
	} else reason = "recognized and available";
	return { providerId, eligible: reason === "recognized and available", reason };
}
