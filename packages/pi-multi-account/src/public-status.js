// @ts-check
// Public, read-only live account status contract (`./public-status` subpath).
//
// This module is the whole runtime a consumer imports. It is plain JavaScript
// so plain Node can load it from node_modules without a TypeScript loader, and
// it deliberately has NO imports: loading the subpath must never load the
// extension, Pi, or any credential-adjacent module. Its types live in the
// hand-written `public-status.d.ts` beside it; the two must export the same
// names (test/public-status.test.ts checks this). The owner-side projection
// lives in `public-status-projection.ts`, which only the extension loads.
//
// The file is type-checked against `public-status.d.ts` through `// @ts-check`
// and the JSDoc below (see `tsconfig.public-status.json`, run by `npm run
// typecheck`). The `@import` tags are comments: they load nothing at runtime.
//
// The wire shape is version 1 and is frozen: the query channel, the
// `sourceVersion`, and the record and cost-estimate shapes must not change in
// place. A new shape needs a new version.

/** @import * as Contract from "./public-status.js" */

/**
 * The service response an owner attaches to a query.
 * @typedef {{
 *   readonly version: typeof Contract.PUBLIC_ACCOUNT_STATUS_SERVICE_VERSION;
 *   readonly createReader: () => Contract.PublicAccountStatusReader;
 * }} ServiceResponse
 */

/**
 * The query object passed over the event bus; the owner fills `response`.
 * @typedef {{
 *   readonly version: typeof Contract.PUBLIC_ACCOUNT_STATUS_SERVICE_VERSION;
 *   response?: unknown;
 * }} ServiceQuery
 */

/** @type {typeof Contract.PUBLIC_ACCOUNT_STATUS_VERSION} */
export const PUBLIC_ACCOUNT_STATUS_VERSION = "public-status-v1";

/** @type {typeof Contract.PUBLIC_ACCOUNT_STATUS_SERVICE_VERSION} */
export const PUBLIC_ACCOUNT_STATUS_SERVICE_VERSION = 1;
/** @type {typeof Contract.PUBLIC_ACCOUNT_STATUS_SERVICE_QUERY} */
export const PUBLIC_ACCOUNT_STATUS_SERVICE_QUERY =
	"pi-multi-account:public-status-service-query:v1";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function record(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is ServiceQuery}
 */
function isQuery(value) {
	return (
		record(value) &&
		value["version"] === PUBLIC_ACCOUNT_STATUS_SERVICE_VERSION &&
		Object.keys(value).every((key) => key === "version" || key === "response")
	);
}

/**
 * @param {unknown} value
 * @returns {value is ServiceResponse}
 */
function isResponse(value) {
	return (
		record(value) &&
		value["version"] === PUBLIC_ACCOUNT_STATUS_SERVICE_VERSION &&
		typeof value["createReader"] === "function" &&
		Object.keys(value).every(
			(key) => key === "version" || key === "createReader",
		)
	);
}

/**
 * Register the owner extension's read-only status service on Pi's shared event
 * transport. The callback owns the live state; this module neither stores
 * credentials nor creates a second account manager. A throwing callback reads
 * as `source-error` and its message never reaches the consumer.
 *
 * @type {typeof Contract.registerPublicAccountStatusService}
 */
export function registerPublicAccountStatusService(events, read) {
	return events.on(PUBLIC_ACCOUNT_STATUS_SERVICE_QUERY, (value) => {
		if (!isQuery(value) || value.response !== undefined) return;
		/** @type {ServiceResponse} */
		const response = {
			version: PUBLIC_ACCOUNT_STATUS_SERVICE_VERSION,
			createReader: () =>
				Object.freeze({
					/** @returns {Promise<Contract.PublicAccountStatusReadResult>} */
					async read() {
						try {
							return await read();
						} catch {
							return { status: "unavailable", reason: "source-error" };
						}
					},
				}),
		};
		value.response = response;
	});
}

/**
 * Discover the optional live owner without treating absence as owner failure.
 *
 * @type {typeof Contract.discoverPublicAccountStatusReader}
 */
export function discoverPublicAccountStatusReader(events) {
	/** @type {ServiceQuery} */
	const query = { version: PUBLIC_ACCOUNT_STATUS_SERVICE_VERSION };
	try {
		events.emit(PUBLIC_ACCOUNT_STATUS_SERVICE_QUERY, query);
	} catch {
		return { status: "unsupported" };
	}
	if (!isResponse(query.response)) return { status: "unsupported" };
	try {
		const reader = query.response.createReader();
		if (!record(reader) || typeof reader["read"] !== "function") {
			return { status: "unsupported" };
		}
		return {
			status: "available",
			reader: { read: reader.read.bind(reader) },
		};
	} catch {
		return { status: "unsupported" };
	}
}
