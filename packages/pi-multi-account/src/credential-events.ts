import { createHash } from "node:crypto";

/**
 * Credential events on Pi's shared event bus.
 *
 * pi-profile pushes a changed login to the operator's other machines as soon as
 * it hears about the change, and pulls newer logins from those machines just
 * before this extension refreshes one. This module is the only place that
 * publishes those two facts.
 *
 * PAYLOAD DISCIPLINE. A payload is built here from two validated strings and
 * nothing else: never a token, expiry, account id, label, path, or error text.
 * Callers cannot pass an object through, so no credential field can reach a
 * listener, whatever the caller holds.
 *
 * FAIL-SOFT. A missing bus (minimal hosts and test doubles) means no events. A
 * bus that throws, including Pi's stale-context guard after shutdown, is
 * caught and dropped, so publishing can never break a refresh, a login, or a
 * request.
 */

/** `{ provider, kind }`: a stored login changed or became unusable. */
export const CREDENTIAL_CHANGED_CHANNEL = "pi-multi-account:credential-changed";
/** `{ provider }`: this extension is about to refresh that login. */
export const CREDENTIAL_REFRESH_DUE_CHANNEL =
	"pi-multi-account:credential-refresh-due";

export const CREDENTIAL_CHANGE_KINDS = ["refresh", "login", "invalidated"] as const;
export type CredentialChangeKind = (typeof CREDENTIAL_CHANGE_KINDS)[number];

/**
 * The host refreshes a stored OAuth credential when less than five minutes of
 * validity remain (`DEFAULT_OAUTH_MINIMUM_VALIDITY_MS` in pi-ai
 * `dist/auth/resolve.js`). A resolve outside that window performs no refresh.
 */
export const HOST_OAUTH_REFRESH_WINDOW_MS = 5 * 60 * 1000;

/** The same provider rule pi-profile applies before acting on a payload. */
const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Structurally compatible with Pi's `pi.events`; only `emit` is used. */
export interface CredentialEventBus {
	emit(channel: string, data: unknown): void;
}

export interface CredentialEvents {
	/** A stored credential changed (`refresh`, `login`) or stopped working. */
	changed(providerId: string, kind: CredentialChangeKind): void;
	/** This extension is about to start a refresh for the provider. */
	refreshDue(providerId: string): void;
	/** False after {@link dispose}; long-running watchers stop then. */
	readonly active: boolean;
	/** Stops all further publication. */
	dispose(): void;
}

/** The publishing half, for code that only announces. */
export type CredentialEventSink = Pick<CredentialEvents, "changed" | "refreshDue">;

function isKind(value: unknown): value is CredentialChangeKind {
	return (
		typeof value === "string" &&
		(CREDENTIAL_CHANGE_KINDS as readonly string[]).includes(value)
	);
}

export function createCredentialEvents(
	bus: CredentialEventBus | undefined,
): CredentialEvents {
	let active = true;
	const publish = (channel: string, payload: object): void => {
		if (!active || bus === undefined) return;
		try {
			bus.emit(channel, Object.freeze(payload));
		} catch {
			// A bus failure, or a listener that throws synchronously, must never
			// reach the refresh, login, or request that announced the change.
		}
	};
	return {
		changed(providerId, kind) {
			if (typeof providerId !== "string" || !PROVIDER_PATTERN.test(providerId)) return;
			if (!isKind(kind)) return;
			publish(CREDENTIAL_CHANGED_CHANNEL, { provider: providerId, kind });
		},
		refreshDue(providerId) {
			if (typeof providerId !== "string" || !PROVIDER_PATTERN.test(providerId)) return;
			publish(CREDENTIAL_REFRESH_DUE_CHANNEL, { provider: providerId });
		},
		get active() {
			return active;
		},
		dispose() {
			active = false;
		},
	};
}

/** Reads the stored credential's expiry; never a credential value. */
export type CredentialRevisionReader = () => number | undefined;

function safeRevision(read: CredentialRevisionReader): number | undefined {
	try {
		const value = read();
		return typeof value === "number" && Number.isFinite(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

export interface ObservedRefreshInput<T> {
	readonly providerId: string;
	readonly events: CredentialEventSink;
	readonly readRevision: CredentialRevisionReader;
	readonly now: () => number;
	/** Runs the host credential resolve that may refresh under the store lock. */
	readonly run: () => Promise<T>;
}

/**
 * Wraps a host credential resolve, such as the near-expiry warmer's, that
 * refreshes only when the stored credential is inside the host's refresh
 * window. Announces `refresh-due` only when the host is going to refresh, and
 * `refresh` only when the stored expiry changed afterwards. When another
 * process had already refreshed, the host skips the refresh under its lock and
 * nothing changes, so no change is announced.
 */
export async function observeCredentialRefresh<T>(
	input: ObservedRefreshInput<T>,
): Promise<T> {
	const before = safeRevision(input.readRevision);
	let due = false;
	try {
		due =
			before !== undefined &&
			before <= input.now() + HOST_OAUTH_REFRESH_WINDOW_MS;
	} catch {
		due = false;
	}
	if (due) input.events.refreshDue(input.providerId);
	const result = await input.run();
	if (due) {
		const after = safeRevision(input.readRevision);
		if (after !== undefined && after !== before) {
			input.events.changed(input.providerId, "refresh");
		}
	}
	return result;
}

/**
 * A one-way digest that identifies one stored OAuth credential: its access and
 * refresh tokens and its expiry. The login watcher compares the credential a
 * login returned with the one in the store, so a store that still holds an
 * earlier credential with the same expiry, or a write that failed, is never
 * mistaken for the new login. The digest stays inside this process: it is never
 * placed in an event payload, a diagnostic, or a file. Returns `undefined` for
 * anything that is not a complete OAuth credential.
 */
export function credentialFingerprint(credential: unknown): string | undefined {
	if (credential === null || typeof credential !== "object") return undefined;
	const { access, refresh, expires } = credential as {
		readonly access?: unknown;
		readonly refresh?: unknown;
		readonly expires?: unknown;
	};
	if (
		typeof access !== "string" ||
		access.length === 0 ||
		typeof refresh !== "string" ||
		refresh.length === 0 ||
		typeof expires !== "number" ||
		!Number.isFinite(expires)
	) {
		return undefined;
	}
	return createHash("sha256")
		.update(JSON.stringify([access, refresh, expires]))
		.digest("hex");
}

/** Reads the stored credential's fingerprint; never a credential value. */
export type CredentialFingerprintReader = () => string | undefined;

function safeFingerprint(read: CredentialFingerprintReader): string | undefined {
	try {
		const value = read();
		return typeof value === "string" && value.length > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

export interface StoredLoginWatch {
	readonly providerId: string;
	/** {@link credentialFingerprint} of the credential the login returned. */
	readonly loginFingerprint: string | undefined;
	readonly readFingerprint: CredentialFingerprintReader;
	readonly events: Pick<CredentialEvents, "changed" | "active">;
	readonly intervalMs?: number;
	readonly maxAttempts?: number;
}

const LOGIN_WATCH_INTERVAL_MS = 250;
const LOGIN_WATCH_MAX_ATTEMPTS = 40;

/**
 * Announces a login once the host has stored its credential.
 *
 * Pi writes the credential through `AuthStorage.modify` only after the
 * provider's `login` callback resolves, and the extension API offers no event
 * for that write. This checks the stored credential a bounded number of times
 * (ten seconds by default) and emits one `login` change when its fingerprint
 * equals the one the login returned. A stored credential that merely shares an
 * expiry with the login's does not match. A login whose credential never reaches
 * the store, such as a cancelled or failed write, emits nothing, and neither
 * does a login that returned no complete OAuth credential. The timer is
 * unreferenced and stops when publication is disposed.
 */
export function watchForStoredLogin(watch: StoredLoginWatch): void {
	const intervalMs = watch.intervalMs ?? LOGIN_WATCH_INTERVAL_MS;
	const maxAttempts = watch.maxAttempts ?? LOGIN_WATCH_MAX_ATTEMPTS;
	const target = watch.loginFingerprint;
	if (target === undefined) return;
	let attempts = 0;
	const check = (): void => {
		if (!watch.events.active) return;
		attempts += 1;
		if (safeFingerprint(watch.readFingerprint) === target) {
			watch.events.changed(watch.providerId, "login");
			return;
		}
		if (attempts < maxAttempts) schedule();
	};
	const schedule = (): void => {
		const timer = setTimeout(check, intervalMs);
		timer.unref?.();
	};
	schedule();
}
