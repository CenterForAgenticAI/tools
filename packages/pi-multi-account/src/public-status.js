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
// The wire shape is version 1 and is frozen: the query channel, the
// `sourceVersion`, and the record and cost-estimate shapes must not change in
// place. A new shape needs a new version.

export const PUBLIC_ACCOUNT_STATUS_VERSION = "public-status-v1";

export const PUBLIC_ACCOUNT_STATUS_SERVICE_VERSION = 1;
export const PUBLIC_ACCOUNT_STATUS_SERVICE_QUERY =
	"pi-multi-account:public-status-service-query:v1";

function record(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isQuery(value) {
	return (
		record(value) &&
		value["version"] === PUBLIC_ACCOUNT_STATUS_SERVICE_VERSION &&
		Object.keys(value).every((key) => key === "version" || key === "response")
	);
}

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
 */
export function registerPublicAccountStatusService(events, read) {
	return events.on(PUBLIC_ACCOUNT_STATUS_SERVICE_QUERY, (value) => {
		if (!isQuery(value) || value.response !== undefined) return;
		value.response = {
			version: PUBLIC_ACCOUNT_STATUS_SERVICE_VERSION,
			createReader: () =>
				Object.freeze({
					async read() {
						try {
							return await read();
						} catch {
							return { status: "unavailable", reason: "source-error" };
						}
					},
				}),
		};
	});
}

/** Discover the optional live owner without treating absence as owner failure. */
export function discoverPublicAccountStatusReader(events) {
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
