// Access to a model gateway service, shared by the gateway adapters (K6, D-7): the adapter posts a scope to
// `<url>/v1/access` with its client secret and gets a short-lived credential and the base URL to use it at.
import { awaitWithContext, type Context } from "@earendil-works/chord/context";
import type { Scope } from "./host/core.ts";

/** What the service answers `POST /v1/access` with: where to send model requests, and with what, until when (ms since the epoch). */
export type Access = { readonly baseUrl: string; readonly credential: string; readonly expiresAt: number };

export type AccessOptions = {
	/** The service's URL. The adapter posts the scope to `<url>/v1/access`. */
	readonly url: string;
	/** The client secret the service bound to this product. It is sent to the service only, never to a model. */
	readonly secret: string;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
};

/** A credential is used until this long before the service says it expires, so a request never starts with one about to lapse. */
const MARGIN_MS = 60_000;
/** Scopes whose access is cached; past this, the oldest is dropped. */
const MAX_SCOPES = 1_024;
const ACCESS_TIMEOUT_MS = 10_000;

/**
 * A Gateway's `access`: asks the service for a credential for the scope and keeps it per scope until a minute before it
 * expires. Callers that ask at the same time share one request, and a failed request is not kept.
 */
export function gatewayAccess(options: AccessOptions): (scope: Scope, context: Context) => Promise<{ readonly baseUrl: string; readonly credential: string }> {
	const { secret } = options;
	const url = new URL("v1/access", options.url.endsWith("/") ? options.url : `${options.url}/`).href;
	const now = options.now ?? Date.now;
	const fetchAccess = options.fetch ?? ((input, init) => fetch(input, init));

	const cache = new Map<string, Access>();
	const pending = new Map<string, Promise<Access>>();
	const request = async (scope: Scope): Promise<Access> => {
		const response = await fetchAccess(url, {
			method: "POST",
			headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
			body: JSON.stringify({ product: scope.product, keys: scope.keys }),
			signal: AbortSignal.timeout(ACCESS_TIMEOUT_MS),
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`the model gateway refused access: HTTP ${response.status}`);
		}
		const body = (await response.json()) as Partial<Access>;
		if (typeof body.baseUrl !== "string" || !/^https?:\/\//.test(body.baseUrl) || typeof body.credential !== "string" || body.credential === "" || typeof body.expiresAt !== "number") {
			throw new Error("the model gateway answered access with an unexpected body");
		}
		return { baseUrl: body.baseUrl, credential: body.credential, expiresAt: body.expiresAt };
	};

	return async (scope, context) => {
		const key = JSON.stringify([scope.product, scope.keys]);
		const cached = cache.get(key);
		if (cached !== undefined && now() < cached.expiresAt - MARGIN_MS) return cached;
		cache.delete(key);
		let shared = pending.get(key);
		if (shared === undefined) {
			shared = request(scope).then(
				(access) => {
					pending.delete(key);
					if (now() < access.expiresAt - MARGIN_MS) {
						if (cache.size >= MAX_SCOPES) cache.delete(cache.keys().next().value!);
						cache.set(key, access);
					}
					return access;
				},
				(error: unknown) => {
					pending.delete(key);
					throw error;
				},
			);
			pending.set(key, shared);
		}
		const access = await awaitWithContext(shared, context);
		return { baseUrl: access.baseUrl, credential: access.credential };
	};
}
